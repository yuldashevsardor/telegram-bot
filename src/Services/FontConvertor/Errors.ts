import { Extension } from "App/Services/FontConvertor/Types";
import { RuntimeError } from "App/Common/Errors";

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
