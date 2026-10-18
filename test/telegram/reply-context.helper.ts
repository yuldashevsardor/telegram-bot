import path from "path";
import { Api, Composer, Context as GrammyContext } from "grammy";
import type { Message, Update, UserFromGetMe } from "@grammyjs/types";
import type { Context } from "app/telegram/bot/bot.types";
import { createFluent } from "app/telegram/locale/locale";
import type { Locale } from "app/telegram/locale/locale.types";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import type { SupportedFormats } from "app/telegram/supported-formats";
import { HelpText } from "app/telegram/command/help/help-text";

const ME = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;

export type ReplyContext = { ctx: Context; replies: string[] };

export type HandlerRun = { ctx: Context; replies: string[]; isPassedOn: boolean };

// The list SupportedFormats gives for the pair matrix of today.
export const supportedFormats = { toText: (): string => "TTF, OTF, WOFF, WOFF2, EOT, SVG" } as SupportedFormats;

// The help with a contact of its own and the size limit of the cloud Bot API.
export const helpText = new HelpText(supportedFormats, "@author", 20);

// The context of a private message translated by the bundles of src/telegram, with the texts of
// ctx.reply() recorded instead of sent.
export async function replyContext(content: Partial<Message>, locale: Locale = DEFAULT_LOCALE): Promise<ReplyContext> {
    const fluent = await createFluent(path.join(process.cwd(), "src", "telegram"));
    const update = {
        update_id: 1,
        message: {
            message_id: 1,
            date: 0,
            chat: { id: 1, type: "private", first_name: "User" },
            from: { id: 1, is_bot: false, first_name: "User" },
            ...content,
        },
    } as Update;
    const replies: string[] = [];
    const ctx = new GrammyContext(update, new Api("test-token"), ME) as Context;

    ctx.t = fluent.withLocale(locale);
    ctx.reply = (async (text: string): Promise<Message.TextMessage> => {
        replies.push(text);

        return {} as Message.TextMessage;
    }) as Context["reply"];

    return { ctx: ctx, replies: replies };
}

// Runs a message through a command or a middleware the way Bot attaches it, through setup(): a
// command has to answer to its own name.
export async function runHandler(
    handler: { setup: (composer: Composer<Context>) => void },
    content: Partial<Message>,
    locale?: Locale,
): Promise<HandlerRun> {
    const { ctx, replies } = await replyContext(content, locale);
    const composer = new Composer<Context>();
    handler.setup(composer);
    let isPassedOn = false;

    await composer.middleware()(ctx, async () => {
        isPassedOn = true;
    });

    return { ctx: ctx, replies: replies, isPassedOn: isPassedOn };
}

export function command(text: string): Partial<Message> {
    return { text: text, entities: [{ type: "bot_command", offset: 0, length: text.length }] };
}
