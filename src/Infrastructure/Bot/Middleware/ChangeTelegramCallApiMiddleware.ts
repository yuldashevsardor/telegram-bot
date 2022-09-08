import { Middleware } from "App/Infrastructure/Bot/Middleware/Middleware";
import { Api, NextFunction, RawApi } from "grammy";
import { Planner } from "App/Domain/Planner/Planner";
import { PRIORITY } from "App/Domain/Broker/Message";
import { inject, injectable } from "inversify";
import { Modules } from "App/Infrastructure/Container/Symbols/Modules";
import { Context } from "App/Infrastructure/Bot/Types";

const TELEGRAM_NO_GROUP_RATE_LIMIT_SET = new Set<string | symbol>([
    "getChat",
    "getChatAdministrators",
    "getChatMembersCount",
    "getChatMember",
    "sendChatAction",
]);

const WEBHOOK_REPLY_METHOD_ALLOW_SET = new Set<string | symbol>([
    "answerCallbackQuery",
    "answerInlineQuery",
    "deleteMessage",
    "leaveChat",
    "sendChatAction",
]);

@injectable()
export class ChangeTelegramCallApiMiddleware extends Middleware {
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
            get: (target, method) => {
                return method === "toJSON" ? "__internal" : callApi.bind(api, method);
            },
        };

        async function callApi(method, payload, signal): Promise<unknown> {
            if (payload.constructor.name !== "Object" || !("chat_id" in payload)) {
                return originRaw[method](payload, signal);
            }

            const chatId = Number(payload.chat_id);
            const isAllowedGroupMethod = TELEGRAM_NO_GROUP_RATE_LIMIT_SET.has(method);
            const isGroup = chatId < 0;
            if (isNaN(chatId) || (isGroup && isAllowedGroupMethod)) {
                return originRaw[method](payload, signal);
            }

            // Это хак, который нужен для того что бы получить результат отправки сообщения через очереди.
            // Создаем переменные для резолва и режекта promise
            // Они будут вызваны после того как сообщения отправится успешно или ошибочно
            let messageResolve;
            let messageReject;

            // Создаем сам promise, который и будем отдавать в ответе этой функции
            const promise = new Promise((resolve, reject) => {
                messageResolve = resolve;
                messageReject = reject;
            });

            const callback = async (): Promise<void> => {
                try {
                    // Если метод был успешно выполнен - резовлим promise который вернули в ответе
                    messageResolve(originRaw[method](payload, signal));
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
        (api as any).raw = new Proxy(originRaw, proxyHandler);
    }
}
