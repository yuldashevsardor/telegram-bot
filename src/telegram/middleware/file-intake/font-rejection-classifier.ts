import { injectable } from "inversify";
import { Extension } from "app/font-convertor/font-convertor.types";
import { InvalidEotFont, NotEot } from "app/font-convertor/validator/eot/eot-font-validator.errors";
import { BrokenSfnt, InvalidSfntFont, NotSfnt } from "app/font-convertor/validator/sfnt/sfnt-font-validator.errors";
import { SfntRule } from "app/font-convertor/validator/sfnt/sfnt-font-validator.types";
import { InvalidSvgFont, NoFont, NotSvg, NotXml } from "app/font-convertor/validator/svg/svg-font-validator.errors";
import { InvalidWoffFont, NotWoff } from "app/font-convertor/validator/woff/woff-font-validator.errors";
import { InvalidWoff2Font, NotWoff2 } from "app/font-convertor/validator/woff2/woff2-font-validator.errors";
import { FontRejection } from "app/telegram/middleware/file-intake/font-rejection";

type ErrorClass = abstract new (...args: never[]) => Error;

// Sorts the error a FontValidator refused a file with into FontRejection.
@injectable()
export class FontRejectionClassifier {
    // The errors that say the file is not in the format of its extension. Only those of that format:
    // a WOFF, a WOFF2 and an EOT file carry an sfnt, and its NotSfnt says that a file in the format
    // is broken inside. An SVG of no font, a drawing, is not in the format either: the format is an
    // SVG font.
    private static readonly NOT_IN_FORMAT: Record<Extension, ReadonlyArray<ErrorClass>> = {
        [Extension.TTF]: [NotSfnt],
        [Extension.OTF]: [NotSfnt],
        [Extension.WOFF]: [NotWoff],
        [Extension.WOFF2]: [NotWoff2],
        [Extension.EOT]: [NotEot],
        [Extension.SVG]: [NotXml, NotSvg, NoFont],
    };

    // The bases of every error a validator refuses a file with, the sfnt one of the font inside a
    // container or an envelope included.
    private static readonly INVALID_FONT: ReadonlyArray<ErrorClass> = [
        InvalidSfntFont,
        InvalidWoffFont,
        InvalidWoff2Font,
        InvalidEotFont,
        InvalidSvgFont,
    ];

    /**
     * Gives `undefined` for an error that is no refusal of the file: one of reading it, say.
     */
    public classify(extension: Extension, error: unknown): FontRejection | undefined {
        if (FontRejectionClassifier.NOT_IN_FORMAT[extension].some((errorClass) => error instanceof errorClass)) {
            return FontRejection.NotInFormat;
        }

        if (this.isCollection(extension, error)) {
            return FontRejection.NotInFormat;
        }

        if (FontRejectionClassifier.INVALID_FONT.some((errorClass) => error instanceof errorClass)) {
            return FontRejection.Broken;
        }

        return undefined;
    }

    // A collection is a sound file of another format, TTC, under the name of one font: the advice to
    // download a damaged font again would not help it.
    private isCollection(extension: Extension, error: unknown): boolean {
        const isSfntExtension = extension === Extension.TTF || extension === Extension.OTF;

        return isSfntExtension && error instanceof BrokenSfnt && error.payload?.["rule"] === SfntRule.Collection;
    }
}
