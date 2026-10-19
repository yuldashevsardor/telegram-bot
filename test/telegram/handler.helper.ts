import path from "path";
import { Api, Composer, Context as GrammyContext } from "grammy";
import type { Message, Update, UserFromGetMe } from "@grammyjs/types";
import type { Context } from "app/telegram/bot/bot.types";
import { createFluent } from "app/telegram/locale/locale";
import type { Locale } from "app/telegram/locale/locale.types";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import type { SessionPayload } from "app/telegram/session/session.types";
import { initialPayload } from "app/telegram/session/session.helper";
import type { SupportedFormats } from "app/telegram/supported-formats";
import { HelpText } from "app/telegram/command/help/help-text";
import { Extension } from "app/font-convertor/font-convertor.types";

const ME = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;

// The formats in the order of the customer journey.
const ORDERED_EXTENSIONS = [Extension.TTF, Extension.OTF, Extension.WOFF, Extension.WOFF2, Extension.EOT, Extension.SVG];

// The sources of a pair matrix where EOT is only a target.
const SOURCE_EXTENSIONS_WITHOUT_EOT: Extension[] = ORDERED_EXTENSIONS.filter((extension) => extension !== Extension.EOT);

// What a handler passed to ctx.reply() besides the text: the keyboard, the message replied to.
export type ReplyOptions = Parameters<Context["reply"]>[1];

export type ReplyContext = { ctx: Context; replies: string[]; replyOptions: ReplyOptions[] };

export type HandlerRun = { ctx: Context; replies: string[]; replyOptions: ReplyOptions[]; isPassedOn: boolean };

// The lists SupportedFormats gives for the pair matrix of today, complete: every format converts
// into every other.
export const supportedFormats = {
    toText: (): string => "TTF, OTF, WOFF, WOFF2, EOT, SVG",
    toSourceText: (): string => "TTF, OTF, WOFF, WOFF2, EOT, SVG",
    toSourceList: (): Extension[] => ORDERED_EXTENSIONS,
    toTargetList: (sourceExtension: Extension): Extension[] => ORDERED_EXTENSIONS.filter((extension) => extension !== sourceExtension),
} as SupportedFormats;

// The lists for a pair matrix where EOT is only a target, for a spec of a text that lists the
// sources: in the matrix of today the list of sources equals the list of all formats, and only a
// list of its own tells which of the two a reply took.
export const supportedFormatsWithEotOnlyTarget = {
    toText: (): string => "TTF, OTF, WOFF, WOFF2, EOT, SVG",
    toSourceText: (): string => "TTF, OTF, WOFF, WOFF2, SVG",
    toSourceList: (): Extension[] => SOURCE_EXTENSIONS_WITHOUT_EOT,
    toTargetList: (sourceExtension: Extension): Extension[] => {
        if (!SOURCE_EXTENSIONS_WITHOUT_EOT.includes(sourceExtension)) {
            return [];
        }

        return ORDERED_EXTENSIONS.filter((extension) => extension !== sourceExtension);
    },
} as SupportedFormats;

// The help with a contact of its own and the size limit of the cloud Bot API.
export const helpText = new HelpText(supportedFormats, "@author", 20);

// The context of a private message translated by the bundles of src/telegram, with the texts of
// ctx.reply() and its options recorded instead of sent. A session passed in is shared with the runs
// it is passed to, as session() gives the updates of one chat the same row.
export async function replyContext(
    content: Partial<Message>,
    locale: Locale = DEFAULT_LOCALE,
    session: SessionPayload = initialPayload(),
): Promise<ReplyContext> {
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
    const replyOptions: ReplyOptions[] = [];
    const ctx = new GrammyContext(update, new Api("test-token"), ME) as Context;

    ctx.session = session;
    ctx.t = fluent.withLocale(locale);
    ctx.reply = (async (text: string, other?: ReplyOptions): Promise<Message.TextMessage> => {
        replies.push(text);
        replyOptions.push(other);

        return {} as Message.TextMessage;
    }) as Context["reply"];

    return { ctx: ctx, replies: replies, replyOptions: replyOptions };
}

// Runs a message through a command or a middleware the way Bot attaches it, through setup(): a
// command has to answer to its own name.
export async function runHandler(
    handler: { setup: (composer: Composer<Context>) => void },
    content: Partial<Message>,
    locale?: Locale,
    session?: SessionPayload,
): Promise<HandlerRun> {
    const { ctx, replies, replyOptions } = await replyContext(content, locale, session);
    const composer = new Composer<Context>();
    handler.setup(composer);
    let isPassedOn = false;

    await composer.middleware()(ctx, async () => {
        isPassedOn = true;
    });

    return { ctx: ctx, replies: replies, replyOptions: replyOptions, isPassedOn: isPassedOn };
}

export function commandMessage(text: string): Partial<Message> {
    return { text: text, entities: [{ type: "bot_command", offset: 0, length: text.length }] };
}
