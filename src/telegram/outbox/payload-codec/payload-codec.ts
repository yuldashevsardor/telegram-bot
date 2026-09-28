import { isAbsolute } from "node:path";
import { InputFile } from "grammy";
import { PathFile } from "app/telegram/path-file/path-file";
import {
    CyclicPayload,
    InvalidFileMarker,
    ReservedFileKey,
    UnstorableString,
    UnsupportedBigInt,
    UnsupportedInputFile,
} from "app/telegram/outbox/payload-codec/payload-codec.errors";

// The key of the object that stands for a file in a stored payload. It is part of the stored format:
// rows written before a change of the key would not be read back. Bot API parameters are
// snake_case, so no parameter of Telegram's own carries it; serialize() rejects an object that
// does, or deserialize() would read it as a file.
const FILE_KEY = "$pathFile";

// Walks the payload the way JSON.stringify will when the row is written, so that nothing reaches
// the row unchecked: a value is taken by its JSON form (see toJson()), and any other object, a class
// instance or one without a prototype included, is read by its own enumerable keys. Of the values
// that are not objects, a string is checked and a bigint throws; the rest are kept as they are and
// left to JSON (undefined, a function).
//
// `enclosing` holds the objects the walk is inside of, from the root down: meeting one of them again
// means the payload refers back to itself, and the walk would never end. An object met twice in
// different branches (`entities: [e, e]`) is not a cycle, so this is the chain down to the value,
// not every object seen.
function store(value: unknown, method: string, path: readonly string[], enclosing: readonly object[]): unknown {
    const json = toJson(value);

    if (json instanceof InputFile) {
        if (!(json instanceof PathFile)) {
            throw UnsupportedInputFile.inMethod(method, path);
        }

        return { [FILE_KEY]: store({ path: json.path, filename: json.filename }, method, path, enclosing) };
    }

    if (typeof json === "string" && !isStorable(json)) {
        throw UnstorableString.inMethod(method, path);
    }

    // JSON.stringify throws a TypeError on it that names neither the method nor the place.
    if (typeof json === "bigint") {
        throw UnsupportedBigInt.inMethod(method, path);
    }

    if (typeof json !== "object" || json === null) {
        return json;
    }

    if (enclosing.includes(json)) {
        throw CyclicPayload.inMethod(method, path);
    }

    const inside = [...enclosing, json];

    if (Array.isArray(json)) {
        return json.map((item: unknown, index) => store(item, method, [...path, String(index)], inside));
    }

    return Object.fromEntries(
        Object.entries(json).map(([key, item]) => {
            if (key === FILE_KEY) {
                throw ReservedFileKey.inMethod(method, FILE_KEY, path);
            }

            if (!isStorable(key)) {
                throw UnstorableString.inMethod(method, [...path, key]);
            }

            return [key, store(item, method, [...path, key], inside)];
        }),
    );
}

// What JSON.stringify writes in place of a value: what its toJSON() returns, then a boxed primitive
// unwrapped. An InputFile is taken as it is: its toJSON() throws, or, once grammY has sent the file,
// returns an attach:// string that means nothing on another node.
function toJson(value: unknown): unknown {
    const json = value instanceof InputFile || !hasToJson(value) ? value : value.toJSON();

    if (json instanceof String || json instanceof Number || json instanceof Boolean || json instanceof BigInt) {
        return json.valueOf();
    }

    return json;
}

function hasToJson(value: unknown): value is { toJSON(): unknown } {
    return typeof value === "object" && value !== null && typeof (value as { toJSON?: unknown }).toJSON === "function";
}

// PostgreSQL rejects U+0000 and a lone UTF-16 surrogate anywhere in a jsonb value, keys included.
function isStorable(text: string): boolean {
    return !text.includes("\u0000") && text.isWellFormed();
}

// The row comes back from JSON, so only arrays and plain objects are walked.
function restore(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(restore);
    }

    if (typeof value !== "object" || value === null) {
        return value;
    }

    if (FILE_KEY in value) {
        return readMarker(value);
    }

    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item)]));
}

// serialize() writes the marker key alone, with the path of a PathFile, which is absolute:
// anything else is a corrupted row, and a key beside the marker would be lost with the object it
// is in.
function readMarker(marker: object): PathFile {
    const file = (marker as Record<string, unknown>)[FILE_KEY];

    if (
        Object.keys(marker).length !== 1 ||
        typeof file !== "object" ||
        file === null ||
        !Object.keys(file).every((key) => key === "path" || key === "filename")
    ) {
        throw InvalidFileMarker.byMarker(marker);
    }

    const { path, filename } = file as Record<string, unknown>;

    if (typeof path !== "string" || !isAbsolute(path) || !(typeof filename === "string" || filename === undefined)) {
        throw InvalidFileMarker.byMarker(marker);
    }

    return new PathFile(path, filename);
}

/**
 * Turns a Bot API payload into a value for the outbox row. A PathFile becomes a marker with its
 * path. Any other InputFile throws, since its data lives only in this process, and so do an object
 * that already carries the marker key, a string or a key jsonb does not store, a bigint, and a
 * payload that refers back to itself. Every error names the method and where in the payload the
 * value sits.
 */
export function serialize(method: string, payload: object): Record<string, unknown> {
    return store(payload, method, [], []) as Record<string, unknown>;
}

/** Rebuilds the payload serialize() made, with a PathFile in place of each marker. */
export function deserialize(payload: Record<string, unknown>): Record<string, unknown> {
    return restore(payload) as Record<string, unknown>;
}
