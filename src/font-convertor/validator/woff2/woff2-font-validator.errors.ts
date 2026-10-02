import { RuntimeError } from "app/shared/errors";
import type { Violation } from "app/font-convertor/validator/woff2/woff2-font-validator.types";

/**
 * The file is not a valid WOFF2 container. `Woff2FontValidator` answers with one of the
 * subclasses, and a caller tells them apart by `instanceof`. The payload of each names the file in
 * `path`.
 */
export class InvalidWoff2Font extends RuntimeError {}

export class NotWoff2 extends InvalidWoff2Font {
    public static bySize(fontPath: string, sizeBytes: number, headerSizeBytes: number): NotWoff2 {
        return new NotWoff2(`File is not WOFF2: it is ${sizeBytes} bytes long, shorter than the ${headerSizeBytes}-byte header.`, {
            path: fontPath,
            sizeBytes: sizeBytes,
        });
    }

    public static bySignature(fontPath: string, signature: string, expected: string): NotWoff2 {
        return new NotWoff2(`File is not WOFF2: its signature is ${signature}, expected ${expected}.`, {
            path: fontPath,
            signature: signature,
        });
    }
}

/**
 * A text from the file reaches the message only as a table tag, which is four bytes long, so
 * nothing here is cut.
 */
export class BrokenWoff2 extends InvalidWoff2Font {
    public static byRule(fontPath: string, violation: Violation): BrokenWoff2 {
        return new BrokenWoff2(BrokenWoff2.message(violation), { path: fontPath, ...violation });
    }

    /**
     * The zlib error is the cause: its message comes from Node's Brotli decoder, not from the file.
     */
    public static byBrotliError(fontPath: string, violation: Violation, error: Error): BrokenWoff2 {
        return new BrokenWoff2(BrokenWoff2.message(violation), { path: fontPath, ...violation, cause: error });
    }

    private static message({ rule, at, field, value, expected }: Violation): string {
        return `WOFF2 breaks a rule: ${rule}. At ${at}: ${field} is ${value}, expected ${expected}.`;
    }
}
