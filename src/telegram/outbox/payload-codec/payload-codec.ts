import { InputFile } from "grammy";
import { InvalidFileMarker, UnsupportedInputFile } from "app/telegram/outbox/payload-codec/payload-codec.errors";

// The key of the object that stands for a file in a stored payload. It is part of the stored format:
// rows written before a change of the key would not be read back. Bot API parameters are
// snake_case, so no parameter of Telegram's own carries it.
const FILE_KEY = "$queuedFile";

// grammY keeps the source of an InputFile private, so the path is remembered here, by the factory.
const queuedFiles = new WeakMap<InputFile, string>();

// Copies arrays and plain objects, replacing whatever swap() returns in place of a value. Other
// values are kept as they are: the row is written through JSON, as grammY sends them.
function rebuild(value: unknown, swap: (value: unknown) => unknown): unknown {
    const swapped = swap(value);

    if (swapped !== value) {
        return swapped;
    }

    if (Array.isArray(value)) {
        return value.map((item) => rebuild(item, swap));
    }

    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebuild(item, swap)]));
    }

    return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** An InputFile the outbox can store: it is sent by another node, which reads the file at `path`. */
export function queueFile(path: string, filename?: string): InputFile {
    const file = new InputFile(path, filename);

    queuedFiles.set(file, path);

    return file;
}

/**
 * Turns a Bot API payload into a value for the outbox row. A file made by queueFile() becomes a
 * marker with its path; any other InputFile throws, since its data lives only in this process.
 */
export function serialize(method: string, payload: object): Record<string, unknown> {
    return rebuild(payload, (value) => {
        if (!(value instanceof InputFile)) {
            return value;
        }

        const path = queuedFiles.get(value);

        if (path === undefined) {
            throw UnsupportedInputFile.inMethod(method);
        }

        return { [FILE_KEY]: { path: path, filename: value.filename } };
    }) as Record<string, unknown>;
}

/** Rebuilds the payload serialize() made, with a queueFile() file in place of each marker. */
export function deserialize(payload: Record<string, unknown>): Record<string, unknown> {
    return rebuild(payload, (value) => {
        if (!isPlainObject(value) || !(FILE_KEY in value)) {
            return value;
        }

        const marker = value[FILE_KEY];

        if (
            !isPlainObject(marker) ||
            typeof marker["path"] !== "string" ||
            !(typeof marker["filename"] === "string" || marker["filename"] === undefined)
        ) {
            throw InvalidFileMarker.byMarker(marker);
        }

        return queueFile(marker["path"], marker["filename"]);
    }) as Record<string, unknown>;
}
