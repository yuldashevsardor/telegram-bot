import { RuntimeError } from "app/shared/errors";

export class ExtensionNotSupport extends RuntimeError {
    public static byExtension(extension: string): ExtensionNotSupport {
        return new ExtensionNotSupport(`Fontforge not support ${extension} extension.`, {
            extension: extension,
        });
    }
}

export class ExecuteError extends RuntimeError {
    /**
     * `sourcePath` is the font the conversion was given. The engine may have read another file, the
     * prepared copy of an SVG source, which is removed by the time the error is logged, so the
     * arguments of the process in `cause` do not name the source.
     */
    public static bySource(sourcePath: string, error: unknown): ExecuteError {
        return new ExecuteError(error instanceof Error ? error.message : "The engine failed.", {
            sourcePath: sourcePath,
            cause: error,
        });
    }
}
