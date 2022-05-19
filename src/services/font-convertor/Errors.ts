export class PermissionDenied extends Error {
    public constructor(message: string) {
        super(message);
    }

    public static read(path: string): PermissionDenied {
        return new PermissionDenied(`Path ${path} is not readable.`);
    }

    public static write(path: string): PermissionDenied {
        return new PermissionDenied(`Path ${path} is not writable.`);
    }
}

export class InvalidFormat extends Error {
    public constructor(message: string) {
        super(message);
    }

    public static byFilePath(path: string): InvalidFormat {
        return new InvalidFormat(`Invalid file format: ${path}`);
    }
}
