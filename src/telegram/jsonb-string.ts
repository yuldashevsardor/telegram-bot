// PostgreSQL rejects U+0000 and a lone UTF-16 surrogate anywhere in a jsonb value, keys included. The
// payload codec of the outbox refuses a payload with either, and the polling source of the inbox
// tells by it an update the store refuses.
export function isJsonbStorable(text: string): boolean {
    return !text.includes("\u0000") && text.isWellFormed();
}
