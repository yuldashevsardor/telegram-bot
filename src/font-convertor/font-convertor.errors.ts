import type { Extension } from "app/font-convertor/font-convertor.types";
import { RuntimeError } from "app/shared/errors";

export class ConvertorNotFound extends RuntimeError {
    public static byExtensions(from: Extension, to: Extension): ConvertorNotFound {
        return new ConvertorNotFound(`Convertor for ${from} to ${to} not found.`, {
            from: from,
            to: to,
        });
    }
}

export class FontConvertorError extends RuntimeError {}
