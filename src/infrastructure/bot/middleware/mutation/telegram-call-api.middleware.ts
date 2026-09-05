import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { Api, NextFunction, RawApi } from "grammy";
import { Planner } from "app/domain/planner/planner";
import { inject, injectable } from "inversify";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { Context } from "app/infrastructure/bot/bot.types";
import { PRIORITY } from "app/domain/broker/broker.types";

type RawApiMethod = keyof RawApi;
type RawApiPayload = Record<string, unknown>;

const TELEGRAM_NO_GROUP_RATE_LIMIT_SET = new Set<string | symbol>([
    "getChat",
    "getChatAdministrators",
    "getChatMembersCount",
    "getChatMember",
    "sendChatAction",
]);

@injectable()
export class TelegramCallApiMiddleware extends Middleware {
    public constructor(@inject<Planner>(Modules.Planner.Planner) private readonly planner: Planner) {
        super();
    }

    protected handle(ctx: Context, next: NextFunction): Promise<void> {
        this.changeTelegramCallApi(ctx.api);

        return next();
    }

    private changeTelegramCallApi(api: Api): void {
        // Сохраняем старый raw, что бы вызывать в брокере реально отправку
        const originRaw = api.raw;
        const planner = this.planner;

        // Готовим ProxyHandler, который будет добавлять запросы в ТГ в Брокера
        const proxyHandler: ProxyHandler<RawApi> = {
            get: (_target, method) => {
                return method === "toJSON" ? "__internal" : callApi.bind(api, method as RawApiMethod);
            },
        };

        // Методы RawApi различаются типом payload, поэтому обращение по вычисляемому имени
        // не типизируется без приведения: конкретный метод известен только в рантайме.
        function callRawApi(method: RawApiMethod, payload: RawApiPayload, signal: AbortSignal | undefined): Promise<unknown> {
            const call = originRaw[method] as (payload: RawApiPayload, signal?: AbortSignal) => Promise<unknown>;

            return call(payload, signal);
        }

        async function callApi(method: RawApiMethod, payload: RawApiPayload, signal: AbortSignal | undefined): Promise<unknown> {
            if (payload.constructor.name !== "Object" || !("chat_id" in payload)) {
                return callRawApi(method, payload, signal);
            }

            const chatId = Number(payload["chat_id"]);
            const isAllowedGroupMethod = TELEGRAM_NO_GROUP_RATE_LIMIT_SET.has(method);
            const isGroup = chatId < 0;
            if (isNaN(chatId) || (isGroup && isAllowedGroupMethod)) {
                return callRawApi(method, payload, signal);
            }

            // Это хак, который нужен для того что бы получить результат отправки сообщения через очереди.
            // Создаем переменные для резолва и режекта promise
            // Они будут вызваны после того как сообщения отправится успешно или ошибочно
            let messageResolve!: (value: unknown) => void;
            let messageReject!: (reason: unknown) => void;

            // Создаем сам promise, который и будем отдавать в ответе этой функции
            const promise = new Promise<unknown>((resolve, reject) => {
                messageResolve = resolve;
                messageReject = reject;
            });

            const callback = async (): Promise<void> => {
                try {
                    // Если метод был успешно выполнен - резовлим promise который вернули в ответе
                    messageResolve(callRawApi(method, payload, signal));
                } catch (e) {
                    // Если была ошибка - соответственно режектим
                    messageReject(e);
                }
            };

            planner.push(
                {
                    chatId: chatId,
                    isGroup: isGroup,
                    priorityOnError: PRIORITY.HIGH,
                    callback: callback,
                },
                PRIORITY.MEDIUM,
            );

            // Возвращаем promise, у которого resolve или reject будут вызваны в методе callback
            return promise;
        }

        // Подменяем RawApi через Proxy на его замену с Брокером
        (api as unknown as { raw: RawApi }).raw = new Proxy(originRaw, proxyHandler);
    }
}
