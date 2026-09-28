import { isAbsolute } from "node:path";
import { InputFile } from "grammy";
import { PathFile } from "app/telegram/path-file/path-file";
import {
    CyclicPayload,
    InvalidFileMarker,
    NulCharacter,
    ReservedFileKey,
    UnsupportedInputFile,
} from "app/telegram/outbox/payload-codec/payload-codec.errors";

// The key of the object that stands for a file in a stored payload. It is part of the stored format:
// rows written before a change of the key would not be read back. Bot API parameters are
// snake_case, so no parameter of Telegram's own carries it; serialize() rejects an object that
// does, or deserialize() would read it as a file.
const FILE_KEY = "$pathFile";

// PostgreSQL rejects it anywhere in a jsonb value, keys included.
const NUL = "\u0000";

// Walks the payload the way JSON.stringify will when the row is written, so that nothing reaches
// the row unchecked: toJSON() is called where JSON calls it, and any other object, a class instance
// or one without a prototype included, is read by its own enumerable keys. Only an InputFile is
// looked at before its toJSON(), which throws. A value that is not an object is kept as is and left
// to JSON (undefined, a function).
function store(value: unknown, method: string, path: readonly string[], ancestors: readonly object[]): unknown {
    if (value instanceof InputFile) {
        if (!(value instanceof PathFile)) {
            throw UnsupportedInputFile.inMethod(method, path);
        }

        return { [FILE_KEY]: { path: value.path, filename: value.filename } };
    }

    const json = hasToJson(value) ? value.toJSON(path.at(-1) ?? "") : value;

    if (typeof json === "string" && json.includes(NUL)) {
        throw NulCharacter.inMethod(method, path);
    }

    if (typeof json !== "object" || json === null) {
        return json;
    }

    if (ancestors.includes(json)) {
        throw CyclicPayload.inMethod(method, path);
    }

    const inside = [...ancestors, json];

    if (Array.isArray(json)) {
        return json.map((item: unknown, index) => store(item, method, [...path, String(index)], inside));
    }

    return Object.fromEntries(
        Object.entries(json).map(([key, item]) => {
            if (key === FILE_KEY) {
                throw ReservedFileKey.inMethod(method, FILE_KEY, path);
            }

            if (key.includes(NUL)) {
                throw NulCharacter.inMethod(method, [...path, key]);
            }

            return [key, store(item, method, [...path, key], inside)];
        }),
    );
}

function hasToJson(value: unknown): value is { toJSON(key: string): unknown } {
    return typeof value === "object" && value !== null && typeof (value as { toJSON?: unknown }).toJSON === "function";
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

// serialize() writes the marker key alone, with a path it has checked to be absolute: anything else
// is a corrupted row, and a key beside the marker would be lost with the object it is in.
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
 * that already carries the marker key, a string or a key with U+0000, and a payload that refers
 * back to itself. Every error names the method and where in the payload the value sits.
 */
export function serialize(method: string, payload: object): Record<string, unknown> {
    return store(payload, method, [], []) as Record<string, unknown>;
}

/** Rebuilds the payload serialize() made, with a PathFile in place of each marker. */
export function deserialize(payload: Record<string, unknown>): Record<string, unknown> {
    return restore(payload) as Record<string, unknown>;
}
