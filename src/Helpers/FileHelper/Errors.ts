import { RuntimeError } from "App/Common/Errors";

export class PermissionDenied extends RuntimeError {
    public static read(path: string): PermissionDenied {
        return new PermissionDenied(`Path ${path} is not readable.`, undefined, {
            path: path,
        });
    }

    public static write(path: string): PermissionDenied {
        return new PermissionDenied(`Path ${path} is not writable.`, undefined, {
            path: path,
        });
    }
}

export class InvalidPath extends RuntimeError {
    public static isNotFile(path: string): InvalidPath {
        return new InvalidPath(`${path} is not file.`, undefined, {
            path: path,
        });
    }

    public static isNotDirectory(path: string): InvalidPath {
        return new InvalidPath(`${path} is not directory.`, undefined, {
            path: path,
        });
    }

    public static isNotExist(path: string): InvalidPath {
        return new InvalidPath(`${path} is not exist.`, undefined, {
            path: path,
        });
    }

    public static isAlreadyExists(path: string): InvalidPath {
        return new InvalidPath(`${path} is already exist.`, undefined, {
            path: path,
        });
    }
}

export class InvalidFile extends RuntimeError {
    public static byPath(path: string): InvalidFile {
        return new InvalidFile(`Invalid file: ${path}.`, undefined, {
            path: path,
        });
    }

    public static byPathAndExtension(path: string, extension: string): InvalidFile {
        return new InvalidFile(`File ${path} extension is invalid. Got: ${extension}.`, undefined, {
            path: path,
            extension: extension,
        });
    }

    public static byPathAndMimeType(path: string, mimeType: string): InvalidFile {
        return new InvalidFile(`File ${path} mimeType is invalid. Got: ${mimeType}.`, undefined, {
            path: path,
            mimeType: mimeType,
        });
    }
}
