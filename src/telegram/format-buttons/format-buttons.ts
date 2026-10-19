import { inject, injectable } from "inversify";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "@grammyjs/types";
import { Tokens } from "app/shared/tokens";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";
import type { FormatButtonData, FormatMark } from "app/telegram/format-buttons/format-buttons.types";
import { FormatButtonCommand } from "app/telegram/format-buttons/format-buttons.types";

// The buttons under the question about a file (docs/product/cjm.md, step 2): the target formats.
@injectable()
export class FormatButtons {
    // The format of the button of all formats.
    public static readonly ALL_FORMATS = "all";

    private static readonly BUTTONS_PER_ROW = 3;

    // The callback data of a button is `${command}:${format}` and names the target alone. The source
    // is found through the message the question replies to: a file id does not fit the 64 bytes
    // Telegram allows for the data.
    private static readonly CALLBACK_DATA_SEPARATOR = ":";
    private static readonly CALLBACK_DATA_PARTS = 2;

    // A marked button keeps its mark in its own command: the keyboard of the question is the only
    // record of what the presses have done (docs/product/cjm.md, step 4).
    private static readonly MARK_SYMBOLS: Record<FormatMark, string> = {
        [FormatButtonCommand.Sent]: "✓",
        [FormatButtonCommand.Failed]: "✗",
    };

    public constructor(@inject<SupportedFormats>(Tokens.Bot.SupportedFormats) private readonly supportedFormats: SupportedFormats) {}

    public build(ctx: Context, sourceExtension: Extension): InlineKeyboard {
        const targetExtensions = this.supportedFormats.toTargetList(sourceExtension);
        const keyboard = new InlineKeyboard();

        for (const [index, targetExtension] of targetExtensions.entries()) {
            if (index > 0 && index % FormatButtons.BUTTONS_PER_ROW === 0) {
                keyboard.row();
            }

            keyboard.text(targetExtension.toUpperCase(), this.toCallbackData(FormatButtonCommand.Convert, targetExtension));
        }

        const allFormatsCallbackData = this.toCallbackData(FormatButtonCommand.Convert, FormatButtons.ALL_FORMATS);

        return keyboard.row().text(ctx.t("format-buttons-all-formats"), allFormatsCallbackData);
    }

    // undefined for the data of any other button: a command the format buttons do not have, or not
    // two parts. The format is not checked: the caller knows which formats it takes.
    public parse(callbackData: string): FormatButtonData | undefined {
        const parts = callbackData.split(FormatButtons.CALLBACK_DATA_SEPARATOR);
        const [commandName, format] = parts;
        const command = Object.values(FormatButtonCommand).find((knownCommand) => knownCommand === commandName);

        if (parts.length !== FormatButtons.CALLBACK_DATA_PARTS || command === undefined || format === undefined) {
            return undefined;
        }

        return { command: command, format: format };
    }

    // undefined for "all formats" and for a format the bot does not know.
    public findTargetExtension(buttonData: FormatButtonData): Extension | undefined {
        return Object.values(Extension).find((extension) => extension === buttonData.format);
    }

    // The keyboard with the buttons of the formats in `marks` marked, or undefined when no button
    // changes: Telegram refuses an edit that changes nothing with a 400.
    public mark(keyboard: InlineKeyboardMarkup, marks: ReadonlyMap<Extension, FormatMark>): InlineKeyboardMarkup | undefined {
        const markedRows: InlineKeyboardButton[][] = [];
        let isChanged = false;

        for (const row of keyboard.inline_keyboard) {
            const markedRow: InlineKeyboardButton[] = [];

            for (const button of row) {
                const markedButton = this.markButton(button, marks);

                if (markedButton !== button) {
                    isChanged = true;
                }

                markedRow.push(markedButton);
            }

            markedRows.push(markedRow);
        }

        if (!isChanged) {
            return undefined;
        }

        return { inline_keyboard: markedRows };
    }

    // The button itself when it keeps its look: "all formats", a format with no mark, a format
    // marked so already.
    private markButton(button: InlineKeyboardButton, marks: ReadonlyMap<Extension, FormatMark>): InlineKeyboardButton {
        if (!("callback_data" in button)) {
            return button;
        }

        const buttonData = this.parse(button.callback_data);

        if (buttonData === undefined) {
            return button;
        }

        const targetExtension = this.findTargetExtension(buttonData);

        if (targetExtension === undefined) {
            return button;
        }

        const mark = marks.get(targetExtension);

        if (mark === undefined) {
            return button;
        }

        const markedCallbackData = this.toCallbackData(mark, targetExtension);

        if (button.callback_data === markedCallbackData) {
            return button;
        }

        return { text: `${FormatButtons.MARK_SYMBOLS[mark]} ${targetExtension.toUpperCase()}`, callback_data: markedCallbackData };
    }

    private toCallbackData(command: FormatButtonCommand, format: string): string {
        return command + FormatButtons.CALLBACK_DATA_SEPARATOR + format;
    }
}
