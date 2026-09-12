import { RuntimeError } from "app/shared/errors";

export class ExtensionNotSupport extends RuntimeError {
    public static byExtension(extension: string): ExtensionNotSupport {
        return new ExtensionNotSupport(`Fontforge not support ${extension} extension.`, {
            extension: extension,
        });
    }
}

export class ExecuteError extends RuntimeError {}
