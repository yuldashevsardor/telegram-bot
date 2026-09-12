import { RuntimeError } from "app/shared/errors";
import type { UnknownObject } from "app/shared/types";

/**
 * Общая форма ошибок файловых операций: сообщение системы, если оно есть, и путь в payload.
 */
function byPathAndError<T extends RuntimeError>(
    error: new (message: string, payloadOrCause?: UnknownObject | Error) => T,
    fallbackMessage: string,
    path: string,
    cause: unknown,
): T {
    return new error(cause instanceof Error ? cause.message : fallbackMessage, {
        path: path,
        cause: cause,
    });
}

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
}

export class ReadFailed extends RuntimeError {
    public static byPath(path: string, error: unknown): ReadFailed {
        return byPathAndError(ReadFailed, `Cannot read file ${path}.`, path, error);
    }
}

export class WriteFailed extends RuntimeError {
    public static byPath(path: string, error: unknown): WriteFailed {
        return byPathAndError(WriteFailed, `Cannot write file ${path}.`, path, error);
    }
}

export class RemoveFailed extends RuntimeError {
    public static byPath(path: string, error: unknown): RemoveFailed {
        return byPathAndError(RemoveFailed, `Cannot remove file ${path}.`, path, error);
    }
}

export class InvalidExtensions extends RuntimeError {
    public static empty(extensions: string[]): InvalidExtensions {
        return new InvalidExtensions("Extensions cannot be empty.", {
            extensions: extensions,
        });
    }
}
