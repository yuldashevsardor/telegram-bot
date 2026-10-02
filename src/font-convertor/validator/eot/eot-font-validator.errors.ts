import { RuntimeError } from "app/shared/errors";
import type { Violation } from "app/font-convertor/validator/eot/eot-font-validator.types";

/**
 * The file is not a valid EOT font. `EotFontValidator` answers with one of the subclasses, and a
 * caller tells them apart by `instanceof`. The payload of each names the file in `path`.
 */
export class InvalidEotFont extends RuntimeError {}

export class NotEot extends InvalidEotFont {
    public static bySize(fontPath: string, sizeBytes: number, fixedSizeBytes: number): NotEot {
        return new NotEot(
            `File is not EOT: it is ${sizeBytes} bytes long, shorter than the ${fixedSizeBytes}-byte fixed part of the header.`,
            {
                path: fontPath,
                sizeBytes: sizeBytes,
            },
        );
    }

    public static byMagicNumber(fontPath: string, magicNumber: string, expected: string): NotEot {
        return new NotEot(`File is not EOT: its MagicNumber is ${magicNumber}, expected ${expected}.`, {
            path: fontPath,
            magicNumber: magicNumber,
        });
    }
}

/**
 * Nothing from the file reaches the message but numbers, so nothing here is cut.
 */
export class BrokenEot extends InvalidEotFont {
    public static byRule(fontPath: string, violation: Violation): BrokenEot {
        return new BrokenEot(BrokenEot.message(violation), { path: fontPath, ...violation });
    }

    /**
     * The error of the parse is the cause: it says what exactly could not be read.
     */
    public static byRuleAndCause(fontPath: string, violation: Violation, error: Error): BrokenEot {
        return new BrokenEot(BrokenEot.message(violation), { path: fontPath, ...violation, cause: error });
    }

    private static message({ rule, at, field, value, expected }: Violation): string {
        return `EOT breaks a rule: ${rule}. At ${at}: ${field} is ${value}, expected ${expected}.`;
    }
}
