import { Context } from "./Context";
import { DEFAULT_PRIORITY, Message } from "../broker/Message";

export function buildMessage(context: Context, callback: () => Promise<unknown>): Message {
    return {
        chatId: context.chat.id,
        isGroup: context.chat.type === "group",
        priorityOnError: DEFAULT_PRIORITY,
        callback: callback,
    };
}
