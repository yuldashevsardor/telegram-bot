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

export class InvalidPath extends Error {
    public constructor(message: string) {
        super(message);
    }

    public static isNotFile(path: string): InvalidPath {
        return new InvalidPath(`${path} is not file.`);
    }

    public static isNotDirectory(path: string): InvalidPath {
        return new InvalidPath(`${path} is not directory.`);
    }

    public static isNotExist(path: string): InvalidPath {
        return new InvalidPath(`${path} is not exist.`);
    }

    public static isAlreadyExists(path: string): InvalidPath {
        return new InvalidPath(`${path} is already exist.`);
    }
}

export class InvalidFile extends Error {
    public constructor(message: string) {
        super(message);
    }

    public static byPath(path: string): InvalidFile {
        return new InvalidFile(`Invalid file: ${path}.`);
    }

    public static byPathAndExtension(path: string, extension: string): InvalidFile {
        return new InvalidFile(`File ${path} extension is invalid. Got: ${extension}.`);
    }

    public static byPathAndMimeType(path: string, mimeType: string): InvalidFile {
        return new InvalidFile(`File ${path} mimeType is invalid. Got: ${mimeType}.`);
    }
}
