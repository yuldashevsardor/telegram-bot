import { RuntimeError } from "app/shared/errors";

// Where a value sits in the payload, for the messages: `media.2.thumbnail`.
function describe(path: readonly string[]): string {
    return path.length === 0 ? "the root" : path.join(".");
}

export class UnsupportedInputFile extends RuntimeError {
    public static inMethod(method: string, path: readonly string[]): UnsupportedInputFile {
        return new UnsupportedInputFile(
            `${method} got an InputFile that is not a PathFile at ${describe(path)}: the outbox stores a file only by its path.`,
            {
                method: method,
                path: describe(path),
            },
        );
    }
}

export class InvalidFileMarker extends RuntimeError {
    public static byMarker(marker: unknown): InvalidFileMarker {
        return new InvalidFileMarker(
            "Stored payload has a malformed file marker: keys beside the marker key, fields other than path and filename, a path that is not an absolute path string, or a file name that is neither a string nor absent.",
            {
                marker: marker,
            },
        );
    }
}

export class ReservedFileKey extends RuntimeError {
    public static inMethod(method: string, key: string, path: readonly string[]): ReservedFileKey {
        return new ReservedFileKey(
            `${method} got an object with the key ${key} at ${describe(path)}, which the outbox keeps for a file marker.`,
            {
                method: method,
                key: key,
                path: describe(path),
            },
        );
    }
}

export class NulCharacter extends RuntimeError {
    public static inMethod(method: string, path: readonly string[]): NulCharacter {
        return new NulCharacter(
            `${method} got a string or a key with U+0000 at ${describe(path)}, which PostgreSQL does not store in jsonb.`,
            {
                method: method,
                path: describe(path),
            },
        );
    }
}

export class CyclicPayload extends RuntimeError {
    public static inMethod(method: string, path: readonly string[]): CyclicPayload {
        return new CyclicPayload(`${method} got a payload that refers back to itself at ${describe(path)}.`, {
            method: method,
            path: describe(path),
        });
    }
}
