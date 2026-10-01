import { RuntimeError } from "app/shared/errors";

/**
 * The codec handles only the envelope: a compressed or encrypted payload cannot be taken out of it.
 */
export class UnsupportedEotFlags extends RuntimeError {
    public static byFlags(flags: number): UnsupportedEotFlags {
        return new UnsupportedEotFlags(`Eot font data is compressed or encrypted: flags 0x${flags.toString(16).padStart(8, "0")}.`, {
            flags: flags,
        });
    }
}
