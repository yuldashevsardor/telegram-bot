import { Api, Context as OriginalContext, RawApi } from "grammy";
import { Update, UserFromGetMe } from "@grammyjs/types";
import { container } from "App/Infrastructure/Container/Container";
import { Planner } from "App/Domain/Planner/Planner";
import { Broker } from "App/Domain/Broker/Broker";
import { Modules } from "App/Infrastructure/Container/Symbols/Modules";
import { PRIORITY } from "App/Domain/Broker/Message";
import { User } from "App/Domain/User/User";
import { SessionPayload } from "App/Infrastructure/Bot/Session/Types";

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

export class Context extends OriginalContext {
    private readonly planner: Planner;
    private readonly broker: Broker;

    public user!: User;
    public session!: SessionPayload;

    constructor(update: Update, api: Api, me: UserFromGetMe) {
        super(update, api, me);
        this.planner = container.get<Planner>(Modules.Planner.Planner);
        this.broker = container.get<Broker>(Modules.Broker.Broker);

        Context.changeTelegramCallApi(api, this.planner);
    }

    /**
     * Хак для подмены RawApi.callApi, который вызывается для всех методов ТГ через Proxy
     */
    private static changeTelegramCallApi(api: Api, planner: Planner): void {
        // Сохраняем старый raw, что бы вызывать в брокере реально отправку
        const originRaw = api.raw;

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

            // Это хак, который нужен для того что бы получить результат отправки сообщения через очереди
            // Создаем переменные для резолва и режекта промиса
            // Они будут вызваны после того как сообщения отправится успешно или ошибочно
            let messageResolve;
            let messageReject;

            // Создаем сам промис, который и будем отдавать в ответе этой функции
            const promise = new Promise((resolve, reject) => {
                messageResolve = resolve;
                messageReject = reject;
            });

            const callback = async (): Promise<void> => {
                try {
                    // Если метод был успешно выполнен - резовлим промис который вернули в ответе
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

            // Возвращаем промис, у которого resolve или reject будут вызваны в методе callback
            return promise;
        }

        // Подменяем RawApi через Proxy на его замену с Брокером
        (api as any).raw = new Proxy(originRaw, proxyHandler);
    }
}
