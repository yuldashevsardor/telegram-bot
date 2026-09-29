import { RuntimeError } from "app/shared/errors";
import type { Violation } from "app/font-convertor/validator/woff/woff-font-validator.types";

/**
 * The file is not a valid WOFF font. `WoffFontValidator` answers with one of the subclasses, and a
 * caller tells them apart by `instanceof`. The payload of each names the file in `path`.
 */
export class InvalidWoffFont extends RuntimeError {}

export class NotWoff extends InvalidWoffFont {
    public static bySize(fontPath: string, sizeBytes: number, headerSizeBytes: number): NotWoff {
        return new NotWoff(`File is not WOFF: it is ${sizeBytes} bytes long, shorter than the ${headerSizeBytes}-byte header.`, {
            path: fontPath,
            sizeBytes: sizeBytes,
        });
    }

    public static bySignature(fontPath: string, signature: string, expected: string): NotWoff {
        return new NotWoff(`File is not WOFF: its signature is ${signature}, expected ${expected}.`, {
            path: fontPath,
            signature: signature,
        });
    }
}

/**
 * A text from the file reaches the message only as a table tag, which is four bytes long, so
 * nothing here is cut.
 */
export class BrokenWoff extends InvalidWoffFont {
    public static byRule(fontPath: string, violation: Violation): BrokenWoff {
        return new BrokenWoff(BrokenWoff.message(violation), { path: fontPath, ...violation });
    }

    /**
     * The zlib error is the cause: its message comes from zlib, not from the file.
     */
    public static byZlibError(fontPath: string, violation: Violation, error: Error): BrokenWoff {
        return new BrokenWoff(BrokenWoff.message(violation), { path: fontPath, ...violation, cause: error });
    }

    private static message({ rule, at, field, value, expected }: Violation): string {
        return `WOFF breaks a rule: ${rule}. At ${at}: ${field} is ${value}, expected ${expected}.`;
    }
}
