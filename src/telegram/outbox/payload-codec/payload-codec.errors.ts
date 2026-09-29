import { RuntimeError } from "app/shared/errors";

const ROOT_PLACE = "the root";

// Where a value sits in the payload, for the messages: `media.2.thumbnail`.
function describe(place: readonly string[]): string {
    return place.length === 0 ? ROOT_PLACE : place.join(".");
}

export class UnsupportedInputFile extends RuntimeError {
    public static inMethod(method: string, place: readonly string[]): UnsupportedInputFile {
        return new UnsupportedInputFile(
            `${method} got an InputFile that is not a PathFile at ${describe(place)}: the outbox stores a file only by its path.`,
            {
                method: method,
                place: describe(place),
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
    public static inMethod(method: string, key: string, place: readonly string[]): ReservedFileKey {
        return new ReservedFileKey(
            `${method} got an object with the key ${key} at ${describe(place)}, which the outbox keeps for a file marker.`,
            {
                method: method,
                key: key,
                place: describe(place),
            },
        );
    }
}

export class UnstorableString extends RuntimeError {
    public static inMethod(method: string, place: readonly string[]): UnstorableString {
        return new UnstorableString(
            `${method} got a string or a key at ${describe(
                place,
            )} that PostgreSQL does not store in jsonb: U+0000 or a lone UTF-16 surrogate.`,
            {
                method: method,
                place: describe(place),
            },
        );
    }
}

export class UnsupportedValue extends RuntimeError {
    public static inMethod(method: string, place: readonly string[]): UnsupportedValue {
        return new UnsupportedValue(
            `${method} got a value at ${describe(
                place,
            )} that the outbox does not store: it takes JSON values, grammY's keyboards and a PathFile.`,
            {
                method: method,
                place: describe(place),
            },
        );
    }

    public static atRoot(method: string): UnsupportedValue {
        return new UnsupportedValue(
            `${method} got a value at ${ROOT_PLACE} that is not a plain object: the outbox stores a payload only as one.`,
            {
                method: method,
                place: ROOT_PLACE,
            },
        );
    }
}
