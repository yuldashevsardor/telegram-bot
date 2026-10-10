import { inject, injectable } from "inversify";
import { FileHelper } from "app/shared/fs/file-helper";
import { EotHeader } from "app/font-convertor/eot-header/eot-header";
import { InvalidEot } from "app/font-convertor/eot-header/eot-header.errors";
import type { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { SfntReader } from "app/font-convertor/eot-packer/sfnt-reader/sfnt-reader";
import type { SfntMetadata } from "app/font-convertor/eot-packer/sfnt-reader/sfnt-reader.types";
import { Tokens } from "app/shared/tokens";

// EOT is not an outline format of its own but an envelope: a header with metadata, then the sfnt
// bytes, untouched or encoded (eot-payload-decoder.ts). Why it bypasses the engine:
// docs/architecture/font-convertor.md, "EOT". The header layout and the versions read are in
// eot-header.ts.

// 0x00020001 is written: the version every EOT reader understands, and the one ttf2eot writes.
const VERSION_WRITTEN = EotHeader.VERSION_2_1;

const CHARSET_DEFAULT = 0x01;

const PANOSE_SIZE = 10;

@injectable()
export class EotPacker {
    public constructor(
        @inject<EotPayloadDecoder>(Tokens.Font.Envelope.PayloadDecoder) private readonly payloadDecoder: EotPayloadDecoder,
    ) {}

    /**
     * Puts an sfnt into an EOT envelope.
     */
    public async pack(sfntPath: string, eotPath: string): Promise<void> {
        const font = await FileHelper.read(sfntPath);
        const metadata = new SfntReader(font).readMetadata();

        await FileHelper.write(eotPath, this.buildEnvelope(font, metadata));
    }

    /**
     * Takes an sfnt out of an EOT envelope, decoding a compressed or encrypted one.
     */
    public async unpack(eotPath: string, sfntPath: string): Promise<void> {
        const eot = await FileHelper.read(eotPath);
        const header = new EotHeader(eot);
        const fontData = this.readFontData(eot, header);
        const font = this.payloadDecoder.decode(fontData, header.flags);

        // A consistent header may still enclose something that is not a font. The check is here
        // because both routes pass here: the unpacked file is either the result itself (eot → ttf)
        // or the input of the engine.
        SfntReader.validate(font);

        await FileHelper.write(sfntPath, font);
    }

    private buildEnvelope(font: Uint8Array, metadata: SfntMetadata): Uint8Array {
        const names = [metadata.familyName, metadata.styleName, metadata.versionName, metadata.fullName].map((name) =>
            this.encodeName(name),
        );
        // Each name gets its size (u16) and the Padding of the next block (u16); Padding1 is
        // already part of FIXED_SIZE_BYTES. The final 2 is the RootStringSize of an empty string:
        // version 0x00020001 requires the field, while the string itself is not written.
        const namesSize = names.reduce((size, name) => size + 4 + name.length, 0);
        const headerSize = EotHeader.FIXED_SIZE_BYTES + namesSize + 2;

        const eot = new Uint8Array(headerSize + font.length);
        const view = new DataView(eot.buffer);

        view.setUint32(0, eot.length, true);
        view.setUint32(4, font.length, true);
        view.setUint32(8, VERSION_WRITTEN, true);
        // Stryker disable next-line BooleanLiteral,CallExpression: `false` and removing the call are equivalent: zero in either byte order is the same zero bytes, and without the write the field stays the zero of a new buffer
        view.setUint32(12, 0, true);
        eot.set(metadata.panose.subarray(0, PANOSE_SIZE), 16);
        view.setUint8(26, CHARSET_DEFAULT);
        view.setUint8(27, metadata.italic);
        view.setUint32(28, metadata.weight, true);
        view.setUint16(32, metadata.fsType, true);
        view.setUint16(EotHeader.MAGIC_NUMBER_OFFSET, EotHeader.MAGIC_NUMBER, true);

        // Stryker disable next-line EqualityOperator: `<=` is equivalent: the extra pass writes undefined, that is zero, into CodePageRange1, and the loop below overwrites it
        for (let index = 0; index < 4; index++) {
            view.setUint32(36 + index * 4, metadata.unicodeRange[index] as number, true);
        }

        // Stryker disable next-line EqualityOperator: `<=` is equivalent: the extra pass writes zero into CheckSumAdjustment, and the line below overwrites it
        for (let index = 0; index < 2; index++) {
            view.setUint32(52 + index * 4, metadata.codePageRange[index] as number, true);
        }

        view.setUint32(60, metadata.checkSumAdjustment, true);

        let offset = EotHeader.FIXED_SIZE_BYTES;

        for (const name of names) {
            view.setUint16(offset, name.length, true);
            eot.set(name, offset + 2);
            // The name is followed by the Padding of the next block, which is already zero.
            offset += 2 + name.length + 2;
        }

        eot.set(font, headerSize);

        return eot;
    }

    private readFontData(eot: Uint8Array, header: EotHeader): Uint8Array {
        if (header.magicNumber !== EotHeader.MAGIC_NUMBER) {
            throw InvalidEot.invalidMagic(header.magicNumber);
        }

        if (header.eotSizeBytes !== eot.length) {
            throw InvalidEot.sizeMismatch(header.eotSizeBytes, eot.length);
        }

        // The names also reject an unknown version.
        const names = header.readNames();

        // The font is the tail of the file, so its start is known without parsing the header. The
        // names are still walked in full: this is how the variable part of the header is checked.
        // They must not run past the font start. The tail of version 0x00020002 is not read: it lies
        // between the names and the font and is not part of the check.
        const fontDataOffset = header.readFontDataOffset();

        if (names.endOffset > fontDataOffset) {
            throw InvalidEot.headerOverlapsFontData(names.endOffset, fontDataOffset);
        }

        return eot.subarray(fontDataOffset);
    }

    private encodeName(name: string): Uint8Array {
        const bytes = new Uint8Array(name.length * 2);
        const view = new DataView(bytes.buffer);

        for (let index = 0; index < name.length; index++) {
            view.setUint16(index * 2, name.charCodeAt(index), true);
        }

        return bytes;
    }
}
