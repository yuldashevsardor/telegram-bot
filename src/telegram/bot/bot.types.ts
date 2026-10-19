import type { Context as GrammyContext, SessionFlavor } from "grammy";
import type { SessionPayload } from "app/telegram/session/session.types";
import type { User } from "app/telegram/user/user";
import type { FluentFlavor } from "app/telegram/locale/locale.types";
import type { Update } from "grammy/types";

// The bot serves only messages in private chats, commands and files among them, and the presses of
// the format buttons under its questions. The getUpdates default is every type but chat_member and
// reactions. What the rest would cost, why a file does not widen the list and why it is not a
// defence: docs/architecture/bot.md.
// Here, beside the Context of the handlers, and not in the polling source of the inbox, which polls
// with it: the list follows what the handlers serve (docs/architecture/invariants.md).
export const ALLOWED_UPDATES: ReadonlyArray<Exclude<keyof Update, "update_id">> = ["message", "callback_query"];

export type Context = GrammyContext & SessionFlavor<SessionPayload> & FluentFlavor & { getUser: () => User };

export type BotSettings = {
    token: string;
    // How a person reaches the author of the bot: the texts name it, and it changes without them.
    authorContact: string;
    // The largest file the bot downloads (getFile): the texts promise no more.
    maxDownloadSizeMb: number;
    // The largest file the bot sends: a result over it is not sent, and the person is told.
    maxUploadSizeMb: number;
};
