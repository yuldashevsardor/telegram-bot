import { RuntimeError } from "App/Common/Errors";

export class ExtensionNotSupport extends RuntimeError {
    public static byExtension(extension: string): ExtensionNotSupport {
        return new ExtensionNotSupport(`Fontforge not support ${extension} extension.`, undefined, {
            extension: extension,
        });
    }
}

export class ExecuteError extends RuntimeError {}
