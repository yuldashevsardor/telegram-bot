import { RuntimeError } from "app/shared/errors";

/**
 * FontData cannot be decoded under the flags of its header. The error of the decoder is the cause:
 * it says what exactly could not be read.
 */
export class InvalidEotPayload extends RuntimeError {
    public static byDecoderError(flags: number, error: Error): InvalidEotPayload {
        return new InvalidEotPayload(`Eot font data cannot be decoded under flags 0x${flags.toString(16).padStart(8, "0")}.`, {
            flags: flags,
            cause: error,
        });
    }
}
