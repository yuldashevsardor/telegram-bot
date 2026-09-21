import { Middleware } from "app/telegram/middleware/middleware";
import type { Api, NextFunction, RawApi } from "grammy";
import type { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { Context } from "app/telegram/bot/bot.types";
import { Priority } from "app/telegram/outbound-queue/task";
import { isGroupChat } from "app/telegram/telegram-chat";

type RawApiMethod = keyof RawApi;
type RawApiPayload = Record<string, unknown>;

const TELEGRAM_NO_GROUP_RATE_LIMIT_SET = new Set<string | symbol>([
    "getChat",
    "getChatAdministrators",
    "getChatMembersCount",
    "getChatMember",
    "sendChatAction",
]);

// grammY calls parameterless methods without a payload: the first argument is a signal or nothing.
function isPayloadLiteral(value: unknown): value is RawApiPayload {
    return typeof value === "object" && value !== null && value.constructor.name === "Object";
}

@injectable()
export class TelegramCallApiMiddleware extends Middleware {
    public constructor(@inject<TaskQueue>(Tokens.Bot.OutboundQueue.TaskQueue) private readonly taskQueue: TaskQueue) {
        super();
    }

    protected handle(ctx: Context, next: NextFunction): Promise<void> {
        this.changeTelegramCallApi(ctx.api);

        return next();
    }

    private changeTelegramCallApi(api: Api): void {
        // The raw kept from before the replacement at the end of this method: the actual send has
        // to go through it and not through api.raw, where the Proxy will sit by then — its get
        // gives back callApi again, and the queue task would loop onto itself instead of sending.
        const originRaw = api.raw;
        const taskQueue = this.taskQueue;

        const proxyHandler: ProxyHandler<RawApi> = {
            get: (_target, method) => {
                return method === "toJSON" ? "__internal" : callApi.bind(api, method as RawApiMethod);
            },
        };

        // The methods of RawApi differ in the type of their payload, so a lookup by a computed
        // name does not type-check without a cast: the concrete method is known only at runtime.
        // The arguments go to originRaw as they came: an empty payload for a parameterless method
        // is supplied by originRaw itself, and one added here as well would take the place of the
        // signal.
        function callRawApi(method: RawApiMethod, args: unknown[]): Promise<unknown> {
            const call = originRaw[method] as (...args: unknown[]) => Promise<unknown>;

            return call(...args);
        }

        async function callApi(method: RawApiMethod, ...args: unknown[]): Promise<unknown> {
            const [payload] = args;
            if (!isPayloadLiteral(payload) || !("chat_id" in payload)) {
                return callRawApi(method, args);
            }

            const chatId = Number(payload["chat_id"]);
            const isAllowedGroupMethod = TELEGRAM_NO_GROUP_RATE_LIMIT_SET.has(method);
            const isGroup = isGroupChat(chatId);
            if (isNaN(chatId) || (isGroup && isAllowedGroupMethod)) {
                return callRawApi(method, args);
            }

            // The caller needs the result of a call that will happen later, inside the queue
            // task, so the resolve and the reject of its promise are hoisted here and called from
            // the callback below once the send has succeeded or failed.
            let messageResolve!: (value: unknown) => void;
            let messageReject!: (reason: unknown) => void;

            const promise = new Promise<unknown>((resolve, reject) => {
                messageResolve = resolve;
                messageReject = reject;
            });

            const callback = async (): Promise<void> => {
                try {
                    // Await the actual call: without it an unsettled promise would leave this
                    // scope and the broker would never see a refusal from Telegram.
                    messageResolve(await callRawApi(method, args));
                } catch (error) {
                    // The caller is refused at once, the broker gets the same error for the ban and the retry.
                    messageReject(error);

                    throw error;
                }
            };

            taskQueue.push(
                {
                    key: chatId,
                    priorityOnError: Priority.HIGH,
                    callback: callback,
                },
                Priority.MEDIUM,
            );

            return promise;
        }

        (api as unknown as { raw: RawApi }).raw = new Proxy(originRaw, proxyHandler);
    }
}
