import { RuntimeError } from "app/shared/errors";
import type { Violation } from "app/font-convertor/validator/sfnt/sfnt-font-validator.types";

/**
 * The file is not a valid TTF or OTF font, or the sfnt a WOFF file carries is not. `SfntFontValidator`
 * answers with one of the subclasses, and a caller tells them apart by `instanceof`. The payload of
 * each names the file in `path`: the TTF or OTF file, or the WOFF file.
 */
export class InvalidSfntFont extends RuntimeError {}

export class NotSfnt extends InvalidSfntFont {
    public static bySize(fontPath: string, sizeBytes: number, headerSizeBytes: number): NotSfnt {
        return new NotSfnt(`File is not sfnt: it is ${sizeBytes} bytes long, shorter than the ${headerSizeBytes}-byte header.`, {
            path: fontPath,
            sizeBytes: sizeBytes,
        });
    }

    public static byVersion(fontPath: string, version: string, expected: string): NotSfnt {
        return new NotSfnt(`File is not sfnt: its version is ${version}, expected ${expected}.`, {
            path: fontPath,
            version: version,
        });
    }
}

/**
 * A text from the file reaches the message only as a table tag, which is four bytes long, so
 * nothing here is cut.
 */
export class BrokenSfnt extends InvalidSfntFont {
    public static byRule(fontPath: string, violation: Violation): BrokenSfnt {
        const { rule, at, field, value, expected } = violation;

        return new BrokenSfnt(`Sfnt font breaks a rule: ${rule}. At ${at}: ${field} is ${value}, expected ${expected}.`, {
            path: fontPath,
            ...violation,
        });
    }
}
