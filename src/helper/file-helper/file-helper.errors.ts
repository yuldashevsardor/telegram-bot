import { RuntimeError } from "app/common/errors";

export class PermissionDenied extends RuntimeError {
    public static read(path: string): PermissionDenied {
        return new PermissionDenied(`Path ${path} is not readable.`, {
            path: path,
        });
    }

    public static write(path: string): PermissionDenied {
        return new PermissionDenied(`Path ${path} is not writable.`, {
            path: path,
        });
    }
}

export class InvalidPath extends RuntimeError {
    public static isNotFile(path: string): InvalidPath {
        return new InvalidPath(`${path} is not file.`, {
            path: path,
        });
    }

    public static isNotDirectory(path: string): InvalidPath {
        return new InvalidPath(`${path} is not directory.`, {
            path: path,
        });
    }

    public static isNotExist(path: string): InvalidPath {
        return new InvalidPath(`${path} is not exists.`, {
            path: path,
        });
    }

    public static isAlreadyExists(path: string): InvalidPath {
        return new InvalidPath(`${path} is already exists.`, {
            path: path,
        });
    }
}

export class InvalidFile extends RuntimeError {
    public static byPath(path: string): InvalidFile {
        return new InvalidFile(`Invalid file: ${path}.`, {
            path: path,
        });
    }

    public static byPathAndExtension(path: string, extension: string, allowed: string): InvalidFile {
        return new InvalidFile(`File ${path} extension is invalid. Got: ${extension}, allowed: ${allowed}.`, {
            path: path,
            extension: extension,
            allowed: allowed,
        });
    }

    public static byUnknownMimeType(path: string): InvalidFile {
        return new InvalidFile(`Cannot get mime type of file ${path}.`, {
            path: path,
        });
    }

    public static byPathAndMimeType(path: string, mimeType: string): InvalidFile {
        return new InvalidFile(`File ${path} mimeType is invalid. Got: ${mimeType}.`, {
            path: path,
            mimeType: mimeType,
        });
    }
}

export class InvalidExtensions extends RuntimeError {
    public static empty(extensions: string[]): InvalidExtensions {
        return new InvalidExtensions("Extensions cannot be empty.", {
            extensions: extensions,
        });
    }
}
