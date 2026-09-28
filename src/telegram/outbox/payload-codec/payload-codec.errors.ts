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
        return new InvalidFileMarker("Stored payload has a file marker that serialize() does not write.", {
            marker: marker,
        });
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

export class UnstorableString extends RuntimeError {
    public static inMethod(method: string, path: readonly string[]): UnstorableString {
        return new UnstorableString(
            `${method} got a string or a key at ${describe(
                path,
            )} that PostgreSQL does not store in jsonb: U+0000 or a lone UTF-16 surrogate.`,
            {
                method: method,
                path: describe(path),
            },
        );
    }
}

export class UnsupportedValue extends RuntimeError {
    public static inMethod(method: string, path: readonly string[]): UnsupportedValue {
        return new UnsupportedValue(
            `${method} got a value at ${describe(
                path,
            )} that the outbox does not store: it takes JSON values, grammY's keyboards and a PathFile.`,
            {
                method: method,
                path: describe(path),
            },
        );
    }
}
