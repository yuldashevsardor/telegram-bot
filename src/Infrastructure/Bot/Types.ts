import { Context as GrammyContext, SessionFlavor } from "grammy";
import { Conversation as GrammyConversation, ConversationFlavor } from "@grammyjs/conversations";
import { SessionPayload } from "App/Infrastructure/Bot/Session/Types";
import { User } from "App/Domain/User/User";

export type Context = GrammyContext & SessionFlavor<SessionPayload> & ConversationFlavor & { user: User };

export type Conversation = GrammyConversation<Context>;

export type BotSettings = {
    token: string;
};
