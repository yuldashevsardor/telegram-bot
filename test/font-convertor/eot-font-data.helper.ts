// The FontData of an EOT and its encodings: the fixture tools the specs of the decoder, the codec
// and the validator share. The offsets, the key and the flags are copies of the format, not the
// constants of the classes, so that a wrong constant in a class fails its spec.

const FONT_DATA_SIZE_OFFSET = 4;
// §4.4: each byte of an encrypted FontData is XOR this key.
const XOR_KEY = 0x50;
// 16 bytes overwritten inside the compressed streams, past the 10-byte MTX header: the decoder
// rejects the result.
const OVERWRITTEN_OFFSET = 100;
const OVERWRITTEN_SIZE_BYTES = 16;
const OVERWRITING_BYTE = 0xff;

// The flags of the header (EOT, §4.2): under the last two FontData is encoded, the first leaves it
// raw.
export const TTEMBED_SUBSET = 0x00000001;
export const TTEMBED_TTCOMPRESSED = 0x00000004;
export const TTEMBED_XORENCRYPTDATA = 0x10000000;

/**
 * FontData is the tail of the file, FontDataSize bytes long. The copy is the caller's to edit.
 */
export function fontDataOf(eot: Uint8Array): Uint8Array {
    const fontDataSizeBytes = new DataView(eot.buffer, eot.byteOffset, eot.byteLength).getUint32(FONT_DATA_SIZE_OFFSET, true);

    return eot.slice(eot.length - fontDataSizeBytes);
}

/**
 * Encrypts or decrypts: XOR is its own inverse.
 */
export function xor(bytes: Uint8Array): Uint8Array {
    return bytes.map((byte) => byte ^ XOR_KEY);
}

export function overwritten(compressedFontData: Uint8Array): Uint8Array {
    return Uint8Array.from(compressedFontData).fill(OVERWRITING_BYTE, OVERWRITTEN_OFFSET, OVERWRITTEN_OFFSET + OVERWRITTEN_SIZE_BYTES);
}
