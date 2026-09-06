import { Context as GrammyContext, SessionFlavor } from "grammy";
import { Conversation as GrammyConversation, ConversationFlavor } from "@grammyjs/conversations";
import { SessionPayload } from "app/infrastructure/bot/session/session.types";
import { User } from "app/domain/user/user";

import { FluentContextFlavor } from "@grammyjs/fluent";

export type Context = GrammyContext & SessionFlavor<SessionPayload> & ConversationFlavor & FluentContextFlavor & { user: User };

export type Conversation = GrammyConversation<Context>;

export type BotSettings = {
    token: string;
};
