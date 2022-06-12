import { Extension } from "App/Services/FontConvertor/Types";

export class ConvertorNotFound extends Error {
    public constructor(message: string) {
        super(message);
    }

    public static byExtensions(from: Extension, to: Extension): ConvertorNotFound {
        return new ConvertorNotFound(`Convertor for ${from} to ${to} not found.`);
    }
}

export class FontConvertorError extends Error {}
