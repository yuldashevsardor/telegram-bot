import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { RuntimeError } from "app/common/errors";

export class ConvertorNotFound extends RuntimeError {
    public static byExtensions(from: Extension, to: Extension): ConvertorNotFound {
        return new ConvertorNotFound({
            message: `Convertor for ${from} to ${to} not found.`,
            payload: {
                from: from,
                to: to,
            },
        });
    }
}

export class FontConvertorError extends RuntimeError {}
