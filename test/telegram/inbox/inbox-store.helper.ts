import type { InboxUpdateInput } from "app/telegram/inbox/store/inbox-store.types";

// A message update of the user in a private chat, with its group.
export function messageInput(updateId: number, userId: number, chatId: number, text = "text"): InboxUpdateInput {
    return {
        userId: userId,
        chatId: chatId,
        update: {
            update_id: updateId,
            message: {
                message_id: updateId,
                date: 0,
                chat: { id: chatId, type: "private", first_name: "User" },
                from: { id: userId, is_bot: false, first_name: "User" },
                text: text,
            },
        },
    };
}
