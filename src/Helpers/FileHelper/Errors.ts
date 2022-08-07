import { RuntimeError } from "App/Common/Errors";

export class PermissionDenied extends RuntimeError {
    public static read(path: string): PermissionDenied {
        return new PermissionDenied({
            message: `Path ${path} is not readable.`,
            payload: {
                path: path,
            },
        });
    }

    public static write(path: string): PermissionDenied {
        return new PermissionDenied({
            message: `Path ${path} is not writable.`,
            payload: {
                path: path,
            },
        });
    }
}

export class InvalidPath extends RuntimeError {
    public static isNotFile(path: string): InvalidPath {
        return new InvalidPath({
            message: `${path} is not file.`,
            payload: {
                path: path,
            },
        });
    }

    public static isNotDirectory(path: string): InvalidPath {
        return new InvalidPath({
            message: `${path} is not directory.`,
            payload: {
                path: path,
            },
        });
    }

    public static isNotExist(path: string): InvalidPath {
        return new InvalidPath({
            message: `${path} is not exists.`,
            payload: {
                path: path,
            },
        });
    }

    public static isAlreadyExists(path: string): InvalidPath {
        return new InvalidPath({
            message: `${path} is already exists.`,
            payload: {
                path: path,
            },
        });
    }
}

export class InvalidFile extends RuntimeError {
    public static byPath(path: string): InvalidFile {
        return new InvalidFile({
            message: `Invalid file: ${path}.`,
            payload: {
                path: path,
            },
        });
    }

    public static byPathAndExtension(path: string, extension: string): InvalidFile {
        return new InvalidFile({
            message: `File ${path} extension is invalid. Got: ${extension}.`,
            payload: {
                path: path,
                extension: extension,
            },
        });
    }

    public static byPathAndMimeType(path: string, mimeType: string): InvalidFile {
        return new InvalidFile({
            message: `File ${path} mimeType is invalid. Got: ${mimeType}.`,
            payload: {
                path: path,
                mimeType: mimeType,
            },
        });
    }
}
