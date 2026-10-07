import type { Context as GrammyContext, SessionFlavor } from "grammy";
import type { Conversation as GrammyConversation, ConversationFlavor } from "@grammyjs/conversations";
import type { SessionPayload } from "app/telegram/session/session.types";
import type { User } from "app/telegram/user/user";
import type { FluentFlavor } from "app/telegram/locale/locale.types";
import type { Update } from "grammy/types";

// The bot serves only commands and a conversation wait() in private chats: a single message
// type. The getUpdates default is every type but chat_member and reactions. What the rest would
// cost, why a file does not widen the list and why it is not a defence: docs/architecture/bot.md.
// Here, beside the Context of the handlers, and not in the polling source of the inbox, which polls
// with it: the list follows what the handlers serve (docs/architecture/invariants.md).
export const ALLOWED_UPDATES: ReadonlyArray<Exclude<keyof Update, "update_id">> = ["message"];

export type Context = GrammyContext & SessionFlavor<SessionPayload> & ConversationFlavor & FluentFlavor & { getUser: () => User };

export type Conversation = GrammyConversation<Context>;

export type BotSettings = {
    token: string;
};
