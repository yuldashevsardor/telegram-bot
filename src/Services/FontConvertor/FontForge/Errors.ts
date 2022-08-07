import { RuntimeError } from "App/Common/Errors";

export class ExtensionNotSupport extends RuntimeError {
    public static byExtension(extension: string): ExtensionNotSupport {
        return new ExtensionNotSupport({
            message: `Fontforge not support ${extension} extension.`,
            payload: {
                extension: extension,
            },
        });
    }
}

export class ExecuteError extends RuntimeError {}
