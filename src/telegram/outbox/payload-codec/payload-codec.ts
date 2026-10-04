import { isAbsolute } from "node:path";
import { InlineKeyboard, InputFile, Keyboard } from "grammy";
import { PathFile } from "app/telegram/path-file/path-file";
import type { OutboxPayload } from "app/telegram/outbox/store/outbox-store.types";
import {
    InvalidFileMarker,
    ReservedFileKey,
    UnstorableString,
    UnsupportedInputFile,
    UnsupportedValue,
} from "app/telegram/outbox/payload-codec/payload-codec.errors";

// The key of the object that stands for a file in a stored payload. It is part of the stored format:
// rows written before a change of the key would not be read back. Bot API parameters are
// snake_case, so no parameter of Telegram's own carries it; serialize() rejects an object that
// does, or deserialize() would read it as a file.
const FILE_KEY = "$pathFile";

// Takes only what it knows how to store: the JSON values, grammY's keyboards and a PathFile; a
// function is dropped, as JSON drops it. Anything else, such as a class instance, a Date or a
// bigint, throws: a Bot API payload grammY builds holds none of it. grammY's keyboards are classes
// with nothing but data fields, which JSON writes as they are.
function store(value: unknown, method: string, place: readonly string[]): unknown {
    if (value instanceof InputFile) {
        if (!(value instanceof PathFile)) {
            throw UnsupportedInputFile.inMethod(method, place);
        }

        return { [FILE_KEY]: store({ path: value.path, filename: value.filename }, method, place) };
    }

    if (typeof value === "string") {
        if (!isStorable(value)) {
            throw UnstorableString.inMethod(method, place);
        }

        return value;
    }

    // InlineQueryResultBuilder leaves its builder methods on a result as fields. JSON drops a
    // function, as when grammY sends the call itself, so the codec drops it too.
    if (typeof value === "function") {
        return undefined;
    }

    if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item: unknown, index) => store(item, method, [...place, String(index)]));
    }

    // A bigint or a symbol, not taken above, throws here too.
    if (!isPlainObject(value) && !(value instanceof InlineKeyboard) && !(value instanceof Keyboard)) {
        throw UnsupportedValue.inMethod(method, place);
    }

    return Object.fromEntries(
        Object.entries(value as object).map(([key, item]) => {
            if (key === FILE_KEY) {
                throw ReservedFileKey.inMethod(method, FILE_KEY, place);
            }

            if (!isStorable(key)) {
                throw UnstorableString.inMethod(method, [...place, key]);
            }

            return [key, store(item, method, [...place, key])];
        }),
    );
}

// Only a plain object has Object.prototype as its prototype. OutboxTransformer queues only such a
// payload, as serialize() takes only such a payload.
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
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

    const { path: filePath, filename } = file as Record<string, unknown>;

    if (typeof filePath !== "string" || !isAbsolute(filePath) || !(typeof filename === "string" || filename === undefined)) {
        throw InvalidFileMarker.byMarker(marker);
    }

    return new PathFile(filePath, filename);
}

/**
 * Turns a Bot API payload into a value for the outbox row. A PathFile becomes a marker with its
 * path. Any other InputFile throws, since its data lives only in this process, and so do an object
 * that already carries the marker key, a string or a key jsonb does not store, a value the codec
 * does not take and a payload that is not a plain object. Every error names the method and where
 * in the payload the value sits.
 */
export function serialize(method: string, payload: object | undefined): OutboxPayload {
    // store() takes an array, a PathFile and a keyboard inside a payload and drops a function there,
    // but a Bot API payload itself is a plain object. Why undefined arrives here and throws too:
    // docs/architecture/outbox.md, "The payload rule".
    if (!isPlainObject(payload)) {
        throw UnsupportedValue.atRoot(method);
    }

    // The one place the type is given: store() has let through only what JSON keeps, so the result
    // goes into OutboxStore.push() as it is, while anything else would need a cast there.
    return store(payload, method, []) as OutboxPayload;
}

/** Rebuilds the payload serialize() made, with a PathFile in place of each marker. */
export function deserialize(payload: Record<string, unknown>): Record<string, unknown> {
    return restore(payload) as Record<string, unknown>;
}

export { isPlainObject };
