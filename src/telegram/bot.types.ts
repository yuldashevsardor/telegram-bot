import { Context as GrammyContext, SessionFlavor } from "grammy";
import { Conversation as GrammyConversation, ConversationFlavor } from "@grammyjs/conversations";
import { SessionPayload } from "app/telegram/session/session.types";
import { User } from "app/telegram/user/user";
import { FluentFlavor } from "app/telegram/locale.types";
import { Filter } from "app/telegram/filter/filter";
import { Middleware } from "app/telegram/middleware/middleware";
import { ConversationHandler } from "app/telegram/conversation/conversation-handler";
import { Command } from "app/telegram/command/command";

export type Context = GrammyContext & SessionFlavor<SessionPayload> & ConversationFlavor & FluentFlavor & { getUser: () => User };

export type Conversation = GrammyConversation<Context>;

export type BotSettings = {
    token: string;
    gracefulShutdown: {
        timeout: number;
    };
};

// Каждый список Bot.setup() вешает в том порядке, в каком получил: порядок внутри списка —
// порядок в пайплайне, и держит его тот, кто собирает объект.
export type BotHandlers = {
    filters: Filter[];
    middlewares: Middleware[];
    conversations: ConversationHandler[];
    commands: Command[];
};
