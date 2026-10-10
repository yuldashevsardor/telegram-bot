import { InvalidEot } from "app/font-convertor/eot-header/eot-header.errors";
import type { EotBlock, EotNames, EotTail } from "app/font-convertor/eot-header/eot-header.types";

// W3C Member Submission "Embedded OpenType (EOT) File Format", 5 March 2008, §3–§3.3. All numbers
// are little-endian, unlike the big-endian sfnt the envelope encloses.
//   0  EOTSize            u32     the size of the whole file
//   4  FontDataSize       u32     the size of the enclosed sfnt
//   8  Version            u32
//  12  Flags              u32
//  16  FontPANOSE         10 bytes
//  26  Charset            u8
//  27  Italic             u8
//  28  Weight             u32
//  32  fsType             u16
//  34  MagicNumber        u16     0x504c
//  36  UnicodeRange1..4   4 × u32
//  52  CodePageRange1..2  2 × u32
//  60  CheckSumAdjustment u32
//  64  Reserved1..4       4 × u32
//  80  Padding1           u16
//  82  FamilyNameSize     u16, then the name in UTF-16LE without a trailing zero
//      Padding2 u16, StyleNameSize   u16, StyleName
//      Padding3 u16, VersionNameSize u16, VersionName
//      Padding4 u16, FullNameSize    u16, FullName
//      Padding5 u16, RootStringSize  u16, RootString        — from version 0x00020001
//      RootStringCheckSum u32, EUDCCodePage u32             — version 0x00020002
//      Padding6 u16, SignatureSize u16, Signature
//      EUDCFlags u32, EUDCFontSize u32, EUDCFontData
//      FontData
const EOT_SIZE_OFFSET = 0;
const FONT_DATA_SIZE_OFFSET = 4;
const VERSION_OFFSET = 8;
const FLAGS_OFFSET = 12;
const RESERVED_OFFSET = 64;
const RESERVED_COUNT = 4;
const PADDING_1_OFFSET = 80;

const USHORT_SIZE_BYTES = 2;
const ULONG_SIZE_BYTES = 4;

/**
 * The header of an EOT envelope: the fixed part, the name blocks of every version, the tail of
 * version 0x00020002 and where the font lies. The codec and `EotFontValidator` both read it, so the
 * domain has one implementation of the parse rather than a copy per reader.
 *
 * The parse rejects only what leaves it nothing to read: a file shorter than a field it reads, an
 * unknown version whose layout it does not know, a FontDataSize that is zero or leaves the font no
 * room. The rest of the format (the magic number, EOTSize, the reserved fields, the extent of the
 * blocks) is exposed for its readers to check.
 *
 * Two boundary checks below are marked equivalent because of what the codec does after them: it
 * reads the names and rejects names that run past the font start (`headerOverlapsFontData` in
 * `EotPacker`). A reader that skips either has to pin those boundaries itself.
 */
export class EotHeader {
    public static readonly FIXED_SIZE_BYTES = 82;
    public static readonly MAGIC_NUMBER_OFFSET = 34;
    public static readonly MAGIC_NUMBER = 0x504c;
    public static readonly VERSION_1_0 = 0x00010000;
    public static readonly VERSION_2_1 = 0x00020001;
    public static readonly VERSION_2_2 = 0x00020002;
    public static readonly VERSIONS: ReadonlyArray<number> = [EotHeader.VERSION_1_0, EotHeader.VERSION_2_1, EotHeader.VERSION_2_2];
    // The two flags (§4.2) under either of which FontData is not a raw sfnt: compressed with
    // MicroType Express or XOR-encrypted (§4.4). `EotPayloadDecoder` reads them.
    public static readonly TTEMBED_TTCOMPRESSED = 0x00000004;
    public static readonly TTEMBED_XORENCRYPTDATA = 0x10000000;

    public readonly eotSizeBytes: number;
    public readonly fontDataSizeBytes: number;
    public readonly version: number;
    public readonly flags: number;
    public readonly magicNumber: number;
    /**
     * Reserved1..4.
     */
    public readonly reserved: ReadonlyArray<number>;

    private readonly view: DataView;

    public constructor(private readonly bytes: Uint8Array) {
        // Stryker disable next-line EqualityOperator: `<=` is equivalent for the codec: a file of exactly 82 bytes ends right before FamilyNameSize, so readNames(), which the codec calls, rejects it too, only the check that rejects it may change
        if (bytes.length < EotHeader.FIXED_SIZE_BYTES) {
            throw InvalidEot.tooShort(bytes.length);
        }

        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.eotSizeBytes = this.view.getUint32(EOT_SIZE_OFFSET, true);
        this.fontDataSizeBytes = this.view.getUint32(FONT_DATA_SIZE_OFFSET, true);
        this.version = this.view.getUint32(VERSION_OFFSET, true);
        this.flags = this.view.getUint32(FLAGS_OFFSET, true);
        this.magicNumber = this.view.getUint16(EotHeader.MAGIC_NUMBER_OFFSET, true);

        const reserved: Array<number> = [];

        for (let index = 0; index < RESERVED_COUNT; index++) {
            reserved.push(this.view.getUint32(RESERVED_OFFSET + index * ULONG_SIZE_BYTES, true));
        }

        this.reserved = reserved;
    }

    /**
     * The four names, and RootString from version 0x00020001.
     */
    public readNames(): EotNames {
        if (!EotHeader.VERSIONS.includes(this.version)) {
            throw InvalidEot.unknownVersion(this.version);
        }

        const familyName = this.readBlock(PADDING_1_OFFSET);
        const styleName = this.readBlock(this.endOf(familyName));
        const versionName = this.readBlock(this.endOf(styleName));
        const fullName = this.readBlock(this.endOf(versionName));

        const rootString = this.version === EotHeader.VERSION_1_0 ? undefined : this.readBlock(this.endOf(fullName));
        const lastBlock = rootString ?? fullName;

        return {
            familyName: familyName,
            styleName: styleName,
            versionName: versionName,
            fullName: fullName,
            rootString: rootString,
            endOffset: this.endOf(lastBlock),
        };
    }

    /**
     * The fields version 0x00020002 adds after RootString; `undefined` for the earlier versions,
     * which have none. The names are read first, so a file cut inside them is rejected in any
     * version.
     */
    public readTail(): EotTail | undefined {
        const names = this.readNames();

        if (this.version !== EotHeader.VERSION_2_2) {
            return undefined;
        }

        // The length check of the signature block also covers RootStringCheckSum and EUDCCodePage in
        // front of it.
        const checkSumOffset = names.endOffset;
        const signature = this.readBlock(checkSumOffset + 2 * ULONG_SIZE_BYTES);
        const eudcFlagsOffset = this.endOf(signature);
        this.requireBytes(eudcFlagsOffset, 2 * ULONG_SIZE_BYTES);

        const eudcFontSizeBytes = this.view.getUint32(eudcFlagsOffset + ULONG_SIZE_BYTES, true);
        const eudcFontOffset = eudcFlagsOffset + 2 * ULONG_SIZE_BYTES;

        return {
            rootStringCheckSum: this.view.getUint32(checkSumOffset, true),
            eudcCodePage: this.view.getUint32(checkSumOffset + ULONG_SIZE_BYTES, true),
            signature: signature,
            eudcFlags: this.view.getUint32(eudcFlagsOffset, true),
            eudcFontOffset: eudcFontOffset,
            eudcFontSizeBytes: eudcFontSizeBytes,
            endOffset: eudcFontOffset + eudcFontSizeBytes,
        };
    }

    /**
     * Where FontData starts. FontData is the last field, so its start is FontDataSize bytes before
     * the end of the file. Whether it follows the header directly is left to the readers.
     */
    public readFontDataOffset(): number {
        // Stryker disable next-line EqualityOperator: `>=` on FontDataSize is equivalent for the codec: a font starting right after the fixed part starts inside FamilyNameSize, so the codec rejects it with headerOverlapsFontData, only the error changes
        if (this.fontDataSizeBytes === 0 || this.fontDataSizeBytes > this.bytes.length - EotHeader.FIXED_SIZE_BYTES) {
            throw InvalidEot.invalidFontDataSize(this.fontDataSizeBytes, this.bytes.length);
        }

        return this.bytes.length - this.fontDataSizeBytes;
    }

    private readBlock(paddingOffset: number): EotBlock {
        this.requireBytes(paddingOffset, 2 * USHORT_SIZE_BYTES);

        return {
            padding: this.view.getUint16(paddingOffset, true),
            offset: paddingOffset + 2 * USHORT_SIZE_BYTES,
            sizeBytes: this.view.getUint16(paddingOffset + USHORT_SIZE_BYTES, true),
        };
    }

    private endOf(block: EotBlock): number {
        return block.offset + block.sizeBytes;
    }

    /**
     * Without the check DataView would throw a RangeError instead of InvalidEot.
     */
    private requireBytes(offset: number, sizeBytes: number): void {
        if (offset + sizeBytes > this.bytes.length) {
            throw InvalidEot.tooShort(this.bytes.length);
        }
    }
}
