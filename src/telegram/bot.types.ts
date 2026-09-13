import type { Context as GrammyContext, SessionFlavor } from "grammy";
import type { Conversation as GrammyConversation, ConversationFlavor } from "@grammyjs/conversations";
import type { SessionPayload } from "app/telegram/session/session.types";
import type { User } from "app/telegram/user/user";
import type { FluentFlavor } from "app/telegram/locale.types";

export type Context = GrammyContext & SessionFlavor<SessionPayload> & ConversationFlavor & FluentFlavor & { getUser: () => User };

export type Conversation = GrammyConversation<Context>;

export type BotSettings = {
    token: string;
    gracefulShutdown: {
        timeout: number;
    };
};
