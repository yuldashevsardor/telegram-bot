import { inject, injectable } from "inversify";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "@grammyjs/types";
import { Tokens } from "app/shared/tokens";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";
import type { MarkedPress } from "app/telegram/format-buttons/format-buttons.types";
import { FormatMark } from "app/telegram/format-buttons/format-buttons.types";

// A format button as its callback data names it: the target, and the mark of a marked one.
type FormatButtonData = { mark: FormatMark | undefined; targetExtension: Extension };

// The buttons under the question about a file (docs/product/cjm.md, step 2): the target formats.
@injectable()
export class FormatButtons {
    // The callback data of a button names the target alone. The source is found through the message
    // the question replies to: a file id does not fit the 64 bytes Telegram allows for the data.
    public static readonly CALLBACK_DATA_PREFIX = "convert:";
    public static readonly ALL_FORMATS = "all";

    private static readonly BUTTONS_PER_ROW = 3;

    // A marked button keeps its mark in its own callback data: the keyboard of the question is the
    // only record of what the presses have done (docs/product/cjm.md, step 4).
    private static readonly MARK_LOOKS: Record<FormatMark, { callbackDataPrefix: string; symbol: string }> = {
        [FormatMark.Sent]: { callbackDataPrefix: "sent:", symbol: "✓" },
        [FormatMark.Failed]: { callbackDataPrefix: "failed:", symbol: "✗" },
    };

    public constructor(@inject<SupportedFormats>(Tokens.Bot.SupportedFormats) private readonly supportedFormats: SupportedFormats) {}

    public build(ctx: Context, sourceExtension: Extension): InlineKeyboard {
        const targetExtensions = this.supportedFormats.toTargetList(sourceExtension);
        const keyboard = new InlineKeyboard();

        for (const [index, targetExtension] of targetExtensions.entries()) {
            if (index > 0 && index % FormatButtons.BUTTONS_PER_ROW === 0) {
                keyboard.row();
            }

            keyboard.text(targetExtension.toUpperCase(), FormatButtons.CALLBACK_DATA_PREFIX + targetExtension);
        }

        return keyboard.row().text(ctx.t("format-buttons-all-formats"), FormatButtons.CALLBACK_DATA_PREFIX + FormatButtons.ALL_FORMATS);
    }

    // undefined for the data of any other button, an unmarked one included.
    public findMarkedPress(callbackData: string): MarkedPress | undefined {
        const buttonData = this.parseFormatButton(callbackData);

        if (buttonData?.mark === undefined) {
            return undefined;
        }

        return { mark: buttonData.mark, targetExtension: buttonData.targetExtension };
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

        const buttonData = this.parseFormatButton(button.callback_data);

        if (buttonData === undefined) {
            return button;
        }

        const { targetExtension } = buttonData;
        const mark = marks.get(targetExtension);

        if (mark === undefined) {
            return button;
        }

        const markLook = FormatButtons.MARK_LOOKS[mark];
        const markedCallbackData = markLook.callbackDataPrefix + targetExtension;

        if (button.callback_data === markedCallbackData) {
            return button;
        }

        return { text: `${markLook.symbol} ${targetExtension.toUpperCase()}`, callback_data: markedCallbackData };
    }

    // undefined for "all formats" and for data of no format button.
    private parseFormatButton(callbackData: string): FormatButtonData | undefined {
        if (callbackData.startsWith(FormatButtons.CALLBACK_DATA_PREFIX)) {
            return this.toButtonData(undefined, callbackData.slice(FormatButtons.CALLBACK_DATA_PREFIX.length));
        }

        for (const mark of Object.values(FormatMark)) {
            const prefix = FormatButtons.MARK_LOOKS[mark].callbackDataPrefix;

            if (callbackData.startsWith(prefix)) {
                return this.toButtonData(mark, callbackData.slice(prefix.length));
            }
        }

        return undefined;
    }

    private toButtonData(mark: FormatMark | undefined, targetName: string): FormatButtonData | undefined {
        const targetExtension = Object.values(Extension).find((extension) => extension === targetName);

        if (targetExtension === undefined) {
            return undefined;
        }

        return { mark: mark, targetExtension: targetExtension };
    }
}
