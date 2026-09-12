import { Context as GrammyContext, SessionFlavor } from "grammy";
import { Conversation as GrammyConversation, ConversationFlavor } from "@grammyjs/conversations";
import { SessionPayload } from "app/infrastructure/bot/session/session.types";
import { User } from "app/domain/user/user";
import { FluentFlavor } from "app/infrastructure/bot/locale.types";

export type Context = GrammyContext & SessionFlavor<SessionPayload> & ConversationFlavor & FluentFlavor & { getUser: () => User };

export type Conversation = GrammyConversation<Context>;

export type BotSettings = {
    token: string;
    gracefulShutdown: {
        timeout: number;
    };
};
