import { InputFile } from "grammy";
import { InvalidFileMarker, ReservedFileKey, UnsupportedInputFile } from "app/telegram/outbox/payload-codec/payload-codec.errors";

// The key of the object that stands for a file in a stored payload. It is part of the stored format:
// rows written before a change of the key would not be read back. Bot API parameters are
// snake_case, so no parameter of Telegram's own carries it; serialize() rejects an object that
// does, or deserialize() would read it as a file.
const FILE_KEY = "$queuedFile";

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

/**
 * The file of a call that goes through the outbox, in place of `new InputFile(path)`. The call is
 * stored in the database and may be sent by another node, so the file travels as its path, and the
 * sending node reads it from there. serialize() accepts no other InputFile: grammY keeps the source
 * of an InputFile private, so only this class can tell the codec its path.
 */
export class QueuedFile extends InputFile {
    public readonly path: string;

    public constructor(path: string, filename?: string) {
        super(path, filename);

        this.path = path;
    }
}

/**
 * Turns a Bot API payload into a value for the outbox row. A QueuedFile becomes a
 * marker with its path; any other InputFile throws, since its data lives only in this process, and
 * so does an object that already carries the marker key.
 */
export function serialize(method: string, payload: object): Record<string, unknown> {
    return rebuild(payload, (value) => {
        if (isPlainObject(value) && FILE_KEY in value) {
            throw ReservedFileKey.inMethod(method);
        }

        if (!(value instanceof InputFile)) {
            return value;
        }

        if (!(value instanceof QueuedFile)) {
            throw UnsupportedInputFile.inMethod(method);
        }

        return { [FILE_KEY]: { path: value.path, filename: value.filename } };
    }) as Record<string, unknown>;
}

/** Rebuilds the payload serialize() made, with a QueuedFile in place of each marker. */
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

        return new QueuedFile(marker["path"], marker["filename"]);
    }) as Record<string, unknown>;
}
