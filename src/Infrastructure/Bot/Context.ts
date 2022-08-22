import { Api, Context as OriginalContext, RawApi } from "grammy";
import { Update, UserFromGetMe } from "@grammyjs/types";
import { container } from "App/Infrastructure/Config/Dependency/Container";
import { Planner } from "App/Domain/Planner/Planner";
import { Broker } from "App/Domain/Broker/Broker";
import { Modules } from "App/Infrastructure/Config/Dependency/Symbols/Modules";
import { PRIORITY } from "App/Domain/Broker/Message";
import { User } from "App/Domain/User/User";

const TELEGRAM_NO_GROUP_RATE_LIMIT_SET = new Set<string>([
    "getChat",
    "getChatAdministrators",
    "getChatMembersCount",
    "getChatMember",
    "sendChatAction",
]);

const WEBHOOK_REPLY_METHOD_ALLOW_SET = new Set<string>([
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
                return callApi.bind(api, method);
            },
        };

        async function callApi(method, payload, signal): Promise<void> {
            if (!("chat_id" in payload)) {
                return originRaw[method](payload, signal);
            }

            const chatId = Number(payload.chat_id);
            const isAllowedGroupMethod = TELEGRAM_NO_GROUP_RATE_LIMIT_SET.has(method);
            const isGroup = chatId < 0;
            if (isNaN(chatId) || (isGroup && isAllowedGroupMethod)) {
                return originRaw[method](payload, signal);
            }

            const callback = (): Promise<unknown> => {
                return originRaw[method](payload, signal);
            };

            planner.push(
                {
                    chatId: chatId,
                    isGroup: isGroup,
                    priorityOnError: PRIORITY.HIGH,
                    callback: callback,
                },
                PRIORITY.HIGH,
            );
        }

        // Подменяем RawApi через Proxy на его замену с Брокером
        (api as any).raw = new Proxy(originRaw, proxyHandler);
    }
}
