import { inject, injectable } from "inversify";
import { InlineKeyboard } from "grammy";
import { Tokens } from "app/shared/tokens";
import type { Extension } from "app/font-convertor/font-convertor.types";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";

// The buttons under the question about a file (docs/product/cjm.md, step 2): the target formats.
@injectable()
export class FormatButtons {
    // The callback data of a button names the target alone. The source is found through the message
    // the question replies to: a file id does not fit the 64 bytes Telegram allows for the data.
    public static readonly CALLBACK_DATA_PREFIX = "convert:";
    public static readonly ALL_FORMATS = "all";

    private static readonly BUTTONS_PER_ROW = 3;

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
}
