import { injectable } from "inversify";
import { decompressMtx } from "mtx-decompressor";
import { EotHeader } from "app/font-convertor/eot-header/eot-header";
import { InvalidEotPayload } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder.errors";

/**
 * Turns FontData into the sfnt it encodes. Under TTEMBED_TTCOMPRESSED FontData is compressed by W3C
 * Member Submission "MicroType Express (MTX) Font Format" (2008), under TTEMBED_XORENCRYPTDATA each
 * byte is XOR 0x50 (EOT, §4.4), and both may be set at once. The decoding is `decompressMtx()` of
 * `mtx-decompressor`, a port of libeot. It sees only FontData: the envelope is parsed by
 * `EotHeader`. The decoding is synchronous and runs on the event loop.
 */
@injectable()
export class EotPayloadDecoder {
    /**
     * `flags` is the Flags field of the header. Without either flag FontData is the sfnt itself and
     * is returned as is.
     */
    public decode(fontData: Uint8Array, flags: number): Uint8Array {
        const isCompressed = (flags & EotHeader.TTEMBED_TTCOMPRESSED) !== 0;
        const isEncrypted = (flags & EotHeader.TTEMBED_XORENCRYPTDATA) !== 0;

        if (!isCompressed && !isEncrypted) {
            return fontData;
        }

        // Every error is taken as broken data, not only the EotError of the library: whatever it
        // throws, it throws on the bytes of the file.
        try {
            return decompressMtx(fontData, { compressed: isCompressed, encrypted: isEncrypted });
        } catch (error) {
            throw InvalidEotPayload.byDecoderError(flags, error);
        }
    }
}
