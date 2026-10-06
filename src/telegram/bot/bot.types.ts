import type { Context as GrammyContext, SessionFlavor } from "grammy";
import type { Conversation as GrammyConversation, ConversationFlavor } from "@grammyjs/conversations";
import type { SessionPayload } from "app/telegram/session/session.types";
import type { User } from "app/telegram/user/user";
import type { FluentFlavor } from "app/telegram/locale/locale.types";
import type { FetchOptions } from "@grammyjs/runner";

// The bot serves only commands and a conversation wait() in private chats: a single message
// type. The getUpdates default is every type but chat_member and reactions. What the rest would
// cost, why a file does not widen the list and why it is not a defence: docs/architecture/bot.md.
// Here and not in bot.ts: the polling source of the inbox polls with it too, without the bot.
export const ALLOWED_UPDATES: NonNullable<FetchOptions["allowed_updates"]> = ["message"];

export type Context = GrammyContext & SessionFlavor<SessionPayload> & ConversationFlavor & FluentFlavor & { getUser: () => User };

export type Conversation = GrammyConversation<Context>;

export type BotSettings = {
    token: string;
    gracefulShutdown: {
        timeout: number;
    };
};
