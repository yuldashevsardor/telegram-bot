import { Context as TelegrafContext, Telegram } from "telegraf";
import * as tg from "typegram";
import { PRIORITY } from "../broker/Message";
import { plannerInstance } from "../planner/Planner";

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

export class Context extends TelegrafContext {
    constructor(update: tg.Update, telegram: Telegram, options?: tg.UserFromGetMe) {
        super(update, telegram, options);
        Context.changeTelegramCallApi(telegram);
    }

    private static changeTelegramCallApi(telegram: Telegram): void {
        const planner = plannerInstance;
        const oldCallApi = telegram.callApi.bind(telegram);

        const newCallApi: typeof telegram.callApi = async function newCallApi(this: typeof telegram, method, payload, { signal } = {}) {
            if (!("chat_id" in payload)) {
                return oldCallApi(method, payload, { signal });
            }

            const chatId = Number(payload.chat_id);
            const hasEnabledWebhookReply = this.options.webhookReply;
            // @ts-ignore
            const hasEndedResponse = this.response?.writableEnded;
            const isAllowedMethod = WEBHOOK_REPLY_METHOD_ALLOW_SET.has(method);
            const isAllowedGroupMethod = TELEGRAM_NO_GROUP_RATE_LIMIT_SET.has(method);
            const isGroup = chatId < 0;
            if (isNaN(chatId) || (hasEnabledWebhookReply && !hasEndedResponse && isAllowedMethod) || (isGroup && isAllowedGroupMethod)) {
                return oldCallApi(method, payload, { signal });
            }

            const callback = (): Promise<unknown> => {
                return oldCallApi(method, payload, { signal });
            };

            planner.push({
                chatId: chatId,
                isGroup: isGroup,
                priorityOnError: PRIORITY.HIGH,
                callback: callback,
            });
        };

        telegram.callApi = newCallApi.bind(telegram);
    }
}
