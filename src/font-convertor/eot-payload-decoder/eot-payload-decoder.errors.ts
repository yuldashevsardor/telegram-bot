import { RuntimeError } from "app/shared/errors";

/**
 * FontData cannot be decoded under the flags of its header. What the decoder threw is the cause: it
 * says what exactly could not be read. A thrown value that is not an Error stays in the payload as
 * `cause` (`RuntimeError`).
 */
export class InvalidEotPayload extends RuntimeError {
    public static byDecoderError(flags: number, error: unknown): InvalidEotPayload {
        return new InvalidEotPayload(`Eot font data cannot be decoded under flags 0x${flags.toString(16).padStart(8, "0")}.`, {
            flags: flags,
            cause: error,
        });
    }
}
