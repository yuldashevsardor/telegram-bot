import { RuntimeError } from "app/shared/errors";

export class InvalidEot extends RuntimeError {
    public static tooShort(length: number): InvalidEot {
        return new InvalidEot(`Eot font is too short: ${length} bytes.`, {
            length: length,
        });
    }

    public static invalidMagic(magic: number): InvalidEot {
        return new InvalidEot(`Eot magic number is 0x${magic.toString(16).padStart(4, "0")}, expected 0x504c.`, {
            magic: magic,
        });
    }

    public static unknownVersion(version: number): InvalidEot {
        return new InvalidEot(`Unknown eot version: 0x${version.toString(16).padStart(8, "0")}.`, {
            version: version,
        });
    }

    public static sizeMismatch(declared: number, actual: number): InvalidEot {
        return new InvalidEot(`Eot declares ${declared} bytes, file has ${actual}.`, {
            declared: declared,
            actual: actual,
        });
    }

    public static invalidFontDataSize(fontDataSize: number, length: number): InvalidEot {
        return new InvalidEot(`Eot declares ${fontDataSize} bytes of font data, which does not fit into ${length} bytes.`, {
            fontDataSize: fontDataSize,
            length: length,
        });
    }

    public static headerOverlapsFontData(headerEnd: number, fontDataOffset: number): InvalidEot {
        return new InvalidEot(`Eot header ends at ${headerEnd}, past the font data start at ${fontDataOffset}.`, {
            headerEnd: headerEnd,
            fontDataOffset: fontDataOffset,
        });
    }
}

/**
 * Кодек умеет только конверт: сжатую и зашифрованную полезную нагрузку из него не достать.
 */
export class UnsupportedEotFlags extends RuntimeError {
    public static byFlags(flags: number): UnsupportedEotFlags {
        return new UnsupportedEotFlags(`Eot font data is compressed or encrypted: flags 0x${flags.toString(16).padStart(8, "0")}.`, {
            flags: flags,
        });
    }
}
