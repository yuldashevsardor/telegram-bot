export class ExtensionNotSupport extends Error {
    public constructor(message: string) {
        super(message);
    }

    public static byExtension(extension: string): ExtensionNotSupport {
        return new ExtensionNotSupport(`Fontforge not support ${extension} extension.`);
    }
}

export class ExecuteError extends Error {}
