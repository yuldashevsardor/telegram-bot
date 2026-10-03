import { injectable } from "inversify";
import { promisify } from "util";
import { brotliDecompress as brotliDecompressOrigin } from "zlib";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";
import { BrokenWoff2, NotWoff2 } from "app/font-convertor/validator/woff2/woff2-font-validator.errors";
import type {
    Block,
    DecompressedTable,
    ExpectedEnd,
    GapEnd,
    ReconstructedTables,
    SfntTable,
    TableEntry,
    TransformedHmtx,
    TransformVersions,
    Woff2,
    Woff2Header,
} from "app/font-convertor/validator/woff2/woff2-font-validator.types";
import { BlockKind, TableTag, Woff2Rule } from "app/font-convertor/validator/woff2/woff2-font-validator.types";
import type { FontValidator } from "app/font-convertor/validator/font-validator";
import { GlyfReconstructor } from "app/font-convertor/validator/woff2/glyf-reconstructor";
import { FileHelper } from "app/shared/fs/file-helper";
import { NumberHelper } from "app/shared/number-helper";

const brotliDecompress = promisify(brotliDecompressOrigin);

/**
 * What `brotliDecompress` gives with `info: true`: the engine as well as the output. Its
 * `bytesWritten` counts the input the engine consumed, and it stops at the end of the Brotli
 * stream. The types of Node describe the output alone.
 */
type Decompressed = {
    buffer: Buffer;
    engine: { bytesWritten: number };
};

/**
 * Checks the WOFF2 container against W3C Recommendation "WOFF File Format 2.0" (8 August 2024):
 * the header (§3.2), the table directory (§4), where the blocks lie in the file (§3, §6, §7), the
 * compressed data (§5), and the transformed tables: `GlyfReconstructor` decodes the glyph records
 * of a transformed glyf and rebuilds glyf, loca and a transformed hmtx from them (§5.1–§5.4). The
 * rebuilt tables are checked only for the size of the sfnt they make up, not handed to the sfnt
 * validator.
 *
 * Deliberately not checked:
 * - `reserved`: "a decoder MUST NOT reject a downloaded font file if the reserved header value is
 *   not zero" (§3.2). The W3C test suite marks header-reserved-001 invalid: the file is invalid,
 *   but a reader loads it.
 * - `totalSfntSize`: "User agents MUST NOT reject correctly decoded font file if the resulting font
 *   file size doesn't match the totalSfntSize" (§3.2).
 * - `origLength` of a transformed glyf: "MUST NOT reject … if the size of the reconstructed 'glyf'
 *   table doesn't match the origLength" (§5.1).
 * - The content of the metadata block: Brotli, `metaOrigLength`, XML, the schema. §6 makes the
 *   block "exactly the same as [WOFF 1]", whose §7 says "A conforming user agent MUST ignore an
 *   invalid metadata block". Only its bounds are checked, and it is never decompressed.
 * - The flavor against the outline tables (W3C tests header-flavor-001/002): the flavor is the
 *   version of the sfnt the tables make up, and a version that disagrees with the outlines passes
 *   the sfnt validator too.
 * - A known tag written out explicitly, flag 63 followed by, say, `cmap`: "The decoder MAY accept"
 *   it (§4.1), and the decoder of fontforge does.
 */
@injectable()
export class Woff2FontValidator implements FontValidator {
    private static readonly SIGNATURE = 0x774f4632;
    private static readonly HEADER_SIZE_BYTES = 48;
    // The offsets of the header fields (§3.2). reserved at 14 and totalSfntSize at 16 are
    // deliberately not read, majorVersion and minorVersion at 24 and 26 have no rule.
    private static readonly HEADER_FIELD_OFFSETS = {
        signature: 0,
        flavor: 4,
        length: 8,
        numTables: 12,
        totalCompressedSize: 20,
        metaOffset: 28,
        metaLength: 32,
        metaOrigLength: 36,
        privOffset: 40,
        privLength: 44,
    };
    // The tags of the flags byte, by bits 0–5, as the table "Known Table Tags" of §4.1 lists them.
    // Index 63 is not here: it says a tag of 4 bytes follows the flags byte.
    private static readonly KNOWN_TAGS: ReadonlyArray<string> = [
        "cmap",
        "head",
        "hhea",
        "hmtx",
        "maxp",
        "name",
        "OS/2",
        "post",
        "cvt ",
        "fpgm",
        "glyf",
        "loca",
        "prep",
        "CFF ",
        "VORG",
        "EBDT",
        "EBLC",
        "gasp",
        "hdmx",
        "kern",
        "LTSH",
        "PCLT",
        "VDMX",
        "vhea",
        "vmtx",
        "BASE",
        "GDEF",
        "GPOS",
        "GSUB",
        "EBSC",
        "JSTF",
        "MATH",
        "CBDT",
        "CBLC",
        "COLR",
        "CPAL",
        "SVG ",
        "sbix",
        "acnt",
        "avar",
        "bdat",
        "bloc",
        "bsln",
        "cvar",
        "fdsc",
        "feat",
        "fmtx",
        "fvar",
        "gvar",
        "hsty",
        "just",
        "lcar",
        "mort",
        "morx",
        "opbd",
        "prop",
        "trak",
        "Zapf",
        "Silf",
        "Glat",
        "Gloc",
        "Feat",
        "Sill",
    ];
    private static readonly TAG_INDEX_MASK = 0x3f;
    private static readonly TRANSFORM_VERSION_SHIFT = 6;
    private static readonly FLAGS_SIZE_BYTES = 1;
    private static readonly TAG_SIZE_BYTES = 4;
    // §3.1: the low 7 bits of a byte carry the value, the high bit says another byte follows.
    private static readonly BASE128_MAX_SIZE_BYTES = 5;
    private static readonly BASE128_LEADING_ZERO = 0x80;
    private static readonly BASE128_CONTINUATION_BIT = 0x80;
    private static readonly BASE128_VALUE_BITS = 0x7f;
    private static readonly BASE128_RADIX = 128;
    private static readonly MAX_UINT32 = 0xffffffff;
    // Version 0 is the transform for glyf and loca, and the null transform for any other table.
    private static readonly GLYF_LOCA_VERSIONS: TransformVersions = { transformed: 0, plain: 3 };
    private static readonly HMTX_VERSIONS: TransformVersions = { transformed: 1, plain: 0 };
    private static readonly TRANSFORM_VERSIONS: ReadonlyMap<string, TransformVersions> = new Map([
        ["glyf", Woff2FontValidator.GLYF_LOCA_VERSIONS],
        ["loca", Woff2FontValidator.GLYF_LOCA_VERSIONS],
        ["hmtx", Woff2FontValidator.HMTX_VERSIONS],
    ]);
    private static readonly OTHER_TABLE_VERSIONS: TransformVersions = { plain: 0 };
    private static readonly HMTX_FLAG_BITS = 0b00000011;
    private static readonly HMTX_RESERVED_BITS = 0b11111100;
    // The metadata and the private block start on it (§6, §7), and so does the end of the file
    // after the compressed data (ours).
    private static readonly ALIGNMENT_BYTES = 4;
    // The two limits of the decoder fontforge reads WOFF2 with, checked on the sum of the table
    // lengths in the directory before Brotli runs. The output buffer fontforge gives the decoder
    // is `woff2::kDefaultMaxSize` in fontforge's `woff2.cc`. The ratio is `kMaxPlausibleCompressionRatio`
    // of `woff2_dec.cc` 1.0.2, which divides the same sum by the file size. The largest of 5796
    // real fonts decompresses to 2 397 699 bytes, and the largest ratio among them is 6.3. A
    // 49 816-byte WOFF2 with an extra table of 512 MiB of zeros took Brotli 227 ms and the process
    // 70 MB of RSS to refuse with a 64 MiB maxOutputLength. The decoder writes the rebuilt sfnt into
    // the same buffer, and the reconstruction can make glyf larger than its transformed form, so the
    // sfnt is capped by it too.
    private static readonly DECODER_BUFFER_SIZE_BYTES = 30 * 1024 * 1024;
    private static readonly MAX_COMPRESSION_RATIO = 100;
    private static readonly SFNT_HEADER_SIZE_BYTES = 12;
    private static readonly SFNT_TABLE_RECORD_SIZE_BYTES = 16;

    /**
     * Throws when the file is not a valid WOFF2 container. The answers are subclasses of
     * `InvalidWoff2Font`: `NotWoff2` for a file shorter than the header or without the signature,
     * `BrokenWoff2` for the first broken rule, checked in the order of the file: the header, the
     * table directory entry by entry, then the directory as a whole, the fields of absent blocks,
     * the layout of the blocks, the size the tables decompress to, the Brotli stream, the
     * transformed tables in it glyph record by glyph record, and the size of the rebuilt sfnt. A
     * file that cannot be read throws `ReadFailed` of `FileHelper` instead: an I/O failure, not a
     * verdict on the font.
     */
    public async validate(fontPath: string): Promise<void> {
        const bytes = await FileHelper.read(fontPath);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        if (bytes.length < Woff2FontValidator.HEADER_SIZE_BYTES) {
            throw NotWoff2.bySize(fontPath, bytes.length, Woff2FontValidator.HEADER_SIZE_BYTES);
        }

        const signature = view.getUint32(Woff2FontValidator.HEADER_FIELD_OFFSETS.signature);

        if (signature !== Woff2FontValidator.SIGNATURE) {
            throw NotWoff2.bySignature(fontPath, this.hex(signature), `${this.hex(Woff2FontValidator.SIGNATURE)} ("wOF2")`);
        }

        const header = this.readHeader(view);

        this.checkHeader(fontPath, header, bytes.length);

        const woff2 = this.readDirectory(fontPath, bytes, header);

        this.checkDirectory(woff2);
        this.checkBlockAbsence(woff2);
        this.checkLayout(woff2);

        const tables = await this.decompressedTables(woff2);

        this.checkSfntSize(fontPath, this.sfntTables(fontPath, tables));
    }

    private readHeader(view: DataView): Woff2Header {
        const fields = Woff2FontValidator.HEADER_FIELD_OFFSETS;

        return {
            flavor: view.getUint32(fields.flavor),
            length: view.getUint32(fields.length),
            numTables: view.getUint16(fields.numTables),
            totalCompressedSize: view.getUint32(fields.totalCompressedSize),
            metaOffset: view.getUint32(fields.metaOffset),
            metaLength: view.getUint32(fields.metaLength),
            metaOrigLength: view.getUint32(fields.metaOrigLength),
            privOffset: view.getUint32(fields.privOffset),
            privLength: view.getUint32(fields.privLength),
        };
    }

    private checkHeader(fontPath: string, header: Woff2Header, fileSizeBytes: number): void {
        const at = "the header";

        if (!SFNT_VERSIONS.includes(header.flavor)) {
            const expected = `one of ${SFNT_VERSIONS.map((version) => this.hex(version)).join(", ")}`;

            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.Flavor,
                at: at,
                field: "flavor",
                value: this.hex(header.flavor),
                expected: expected,
            });
        }

        if (header.length !== fileSizeBytes) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.Length,
                at: at,
                field: "length",
                value: header.length,
                expected: `${fileSizeBytes}, the file size`,
            });
        }

        if (header.numTables === 0) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.TablesPresent,
                at: at,
                field: "numTables",
                value: header.numTables,
                expected: "at least 1",
            });
        }
    }

    /**
     * The entries one by one. An entry has no fixed size: whether it carries a tag and
     * transformLength depends on its flags byte, and its lengths are UIntBase128. So each entry is
     * checked as it is read, and the next one starts where it ends.
     */
    private readDirectory(fontPath: string, bytes: Uint8Array, header: Woff2Header): Woff2 {
        const entries: Array<TableEntry> = [];
        let offset = Woff2FontValidator.HEADER_SIZE_BYTES;

        for (let index = 0; index < header.numTables; index++) {
            const parsedEntry = this.readEntry(fontPath, bytes, offset, `directory entry ${index + 1}`);

            entries.push(parsedEntry.entry);
            offset = parsedEntry.end;
        }

        return { path: fontPath, bytes: bytes, header: header, entries: entries, directoryEnd: offset };
    }

    private readEntry(fontPath: string, bytes: Uint8Array, entryOffset: number, entryName: string): { entry: TableEntry; end: number } {
        const flags = this.byteAt(fontPath, bytes, entryOffset, entryName);
        const tagIndex = flags & Woff2FontValidator.TAG_INDEX_MASK;
        const transformVersion = flags >> Woff2FontValidator.TRANSFORM_VERSION_SHIFT;
        let offset = entryOffset + Woff2FontValidator.FLAGS_SIZE_BYTES;
        let tag = Woff2FontValidator.KNOWN_TAGS[tagIndex];

        // Index 63 has no known tag: the tag follows the flags byte. Its last byte is read first, so
        // that a tag cut by the end of the file breaks the rule.
        if (tag === undefined) {
            this.byteAt(fontPath, bytes, offset + Woff2FontValidator.TAG_SIZE_BYTES - 1, entryName);
            tag = Buffer.from(bytes.subarray(offset, offset + Woff2FontValidator.TAG_SIZE_BYTES)).toString("latin1");
            offset += Woff2FontValidator.TAG_SIZE_BYTES;
        }

        const isTransformed = this.isTransformed(fontPath, tag, transformVersion);
        const parsedOrigLength = this.readUIntBase128(fontPath, bytes, offset, { entryName: entryName, tag: tag, field: "origLength" });
        let transformLength: number | undefined;

        offset = parsedOrigLength.end;

        if (isTransformed) {
            const parsedTransformLength = this.readUIntBase128(fontPath, bytes, offset, {
                entryName: entryName,
                tag: tag,
                field: "transformLength",
            });

            transformLength = parsedTransformLength.value;
            offset = parsedTransformLength.end;
        }

        const entry = {
            tag: tag,
            transformVersion: transformVersion,
            origLength: parsedOrigLength.value,
            transformLength: transformLength,
        };

        return { entry: entry, end: offset };
    }

    /**
     * Whether the transform version of the table is a transform rather than the null transform;
     * throws when the version is not defined for the table at all.
     */
    private isTransformed(fontPath: string, tag: string, transformVersion: number): boolean {
        const versions = Woff2FontValidator.TRANSFORM_VERSIONS.get(tag) ?? Woff2FontValidator.OTHER_TABLE_VERSIONS;

        if (transformVersion === versions.transformed) {
            return true;
        }

        if (transformVersion === versions.plain) {
            return false;
        }

        const defined = [versions.plain];

        if (versions.transformed !== undefined) {
            defined.push(versions.transformed);
        }

        throw BrokenWoff2.byRule(fontPath, {
            rule: Woff2Rule.TransformVersion,
            at: BrokenWoff2.tableName(tag),
            field: "transform version",
            value: transformVersion,
            expected: defined.toSorted((left, right) => left - right).join(" or "),
        });
    }

    /**
     * A UIntBase128 (§3.1) as the pseudo-code of the standard reads it. Its overflow check, a bit
     * among the top 7 of the value before the shift, is the same as a result over 2^32 − 1, and
     * the result is checked: the operands of JavaScript bitwise operators are 32-bit signed.
     */
    private readUIntBase128(
        fontPath: string,
        bytes: Uint8Array,
        offset: number,
        where: { entryName: string; tag: string; field: string },
    ): { value: number; end: number } {
        const violation = { rule: Woff2Rule.UIntBase128, at: BrokenWoff2.tableName(where.tag), field: where.field };
        let value = 0;

        for (let index = 0; index < Woff2FontValidator.BASE128_MAX_SIZE_BYTES; index++) {
            const byte = this.byteAt(fontPath, bytes, offset + index, where.entryName);
            const encoding = this.hexBytes(bytes.subarray(offset, offset + index + 1));

            if (index === 0 && byte === Woff2FontValidator.BASE128_LEADING_ZERO) {
                throw BrokenWoff2.byRule(fontPath, { ...violation, value: encoding, expected: "a first byte other than 80" });
            }

            value = value * Woff2FontValidator.BASE128_RADIX + (byte & Woff2FontValidator.BASE128_VALUE_BITS);

            if (value > Woff2FontValidator.MAX_UINT32) {
                throw BrokenWoff2.byRule(fontPath, {
                    ...violation,
                    value: encoding,
                    expected: `a value of at most ${Woff2FontValidator.MAX_UINT32}`,
                });
            }

            if ((byte & Woff2FontValidator.BASE128_CONTINUATION_BIT) === 0) {
                return { value: value, end: offset + index + 1 };
            }
        }

        throw BrokenWoff2.byRule(fontPath, {
            ...violation,
            value: this.hexBytes(bytes.subarray(offset, offset + Woff2FontValidator.BASE128_MAX_SIZE_BYTES)),
            expected: `at most ${Woff2FontValidator.BASE128_MAX_SIZE_BYTES} bytes, the last with bit 7 clear`,
        });
    }

    /**
     * A byte of the table directory; the directory running past the end of the file breaks a rule.
     */
    private byteAt(fontPath: string, bytes: Uint8Array, offset: number, entryName: string): number {
        const byte = bytes[offset];

        if (byte === undefined) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.DirectoryInFile,
                at: entryName,
                field: "end",
                value: offset + 1,
                expected: `at most ${bytes.length}, the file size`,
            });
        }

        return byte;
    }

    /**
     * The directory as a whole, once every entry is read: one entry per tag, glyf and loca as a
     * pair, and a transformed hmtx only beside a transformed glyf.
     */
    private checkDirectory({ path, entries }: Woff2): void {
        const indexByTag = new Map<string, number>();

        entries.forEach((entry, index) => {
            const firstIndex = indexByTag.get(entry.tag);

            if (firstIndex !== undefined) {
                throw BrokenWoff2.byRule(path, {
                    rule: Woff2Rule.SingleEntry,
                    at: BrokenWoff2.tableName(entry.tag),
                    field: "directory entry",
                    value: index + 1,
                    expected: `none but entry ${firstIndex + 1}, which has the tag already`,
                });
            }

            indexByTag.set(entry.tag, index);
        });

        this.checkGlyfLoca(path, entries);
        this.checkHmtx(path, entries);
    }

    /**
     * A transformed hmtx takes the xMin of the glyphs from glyf (§5.4). The standard asks for glyf
     * alone; the decoder of fontforge reads the glyph count and the xMin only when it rebuilds a
     * transformed glyf (`ReconstructGlyf()` in `woff2_dec.cc` 1.0.2), and refuses the file otherwise.
     */
    private checkHmtx(fontPath: string, entries: Array<TableEntry>): void {
        const hmtx = entries.find((entry) => entry.tag === TableTag.Hmtx);
        const glyf = entries.find((entry) => entry.tag === TableTag.Glyf);

        if (hmtx?.transformLength === undefined) {
            return;
        }

        const violation = {
            at: BrokenWoff2.tableName(TableTag.Hmtx),
            field: "transform version",
            value: hmtx.transformVersion,
        };

        if (glyf === undefined) {
            throw BrokenWoff2.byRule(fontPath, {
                ...violation,
                rule: Woff2Rule.HmtxTransform,
                expected: `${Woff2FontValidator.HMTX_VERSIONS.plain}, as the font has no table "glyf"`,
            });
        }

        if (glyf.transformLength === undefined) {
            throw BrokenWoff2.byRule(fontPath, {
                ...violation,
                rule: Woff2Rule.HmtxBesideTransformedGlyf,
                expected: `${Woff2FontValidator.HMTX_VERSIONS.plain}, as table "glyf" is not transformed`,
            });
        }
    }

    private checkGlyfLoca(fontPath: string, entries: Array<TableEntry>): void {
        const glyf = entries.find((entry) => entry.tag === TableTag.Glyf);
        const loca = entries.find((entry) => entry.tag === TableTag.Loca);

        if (glyf === undefined && loca === undefined) {
            return;
        }

        if (glyf === undefined || loca === undefined) {
            const [present, absent] = glyf === undefined ? [TableTag.Loca, TableTag.Glyf] : [TableTag.Glyf, TableTag.Loca];

            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.GlyfLoca,
                at: "the table directory",
                field: `table ${JSON.stringify(absent)}`,
                value: "absent",
                expected: `present, as table ${JSON.stringify(present)} is`,
            });
        }

        const glyfIndex = entries.indexOf(glyf);
        const locaIndex = entries.indexOf(loca);
        const locaName = BrokenWoff2.tableName(TableTag.Loca);

        if (glyf.transformVersion !== loca.transformVersion) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.GlyfLoca,
                at: locaName,
                field: "transform version",
                value: loca.transformVersion,
                expected: `${glyf.transformVersion}, the transform version of table "glyf"`,
            });
        }

        if (locaIndex < glyfIndex) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.GlyfLoca,
                at: locaName,
                field: "directory entry",
                value: locaIndex + 1,
                expected: `any entry after entry ${glyfIndex + 1}, the entry of table "glyf"`,
            });
        }

        if (loca.transformLength !== undefined && loca.transformLength !== 0) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.LocaTransform,
                at: locaName,
                field: "transformLength",
                value: loca.transformLength,
                expected: "0",
            });
        }
    }

    private checkBlockAbsence({ path, header }: Woff2): void {
        this.checkAbsence(path, ["metaOffset", header.metaOffset], ["metaLength", header.metaLength]);

        if (header.metaOffset === 0 && header.metaOrigLength !== 0) {
            throw BrokenWoff2.byRule(path, {
                rule: Woff2Rule.BlockAbsence,
                at: "the header",
                field: "metaOrigLength",
                value: header.metaOrigLength,
                expected: "0, as metaOffset is 0",
            });
        }

        this.checkAbsence(path, ["privOffset", header.privOffset], ["privLength", header.privLength]);
    }

    /**
     * The offset and the length of a block are both 0 or both not: the one that is not 0 breaks the
     * rule.
     */
    private checkAbsence(fontPath: string, [offsetName, offset]: [string, number], [lengthName, length]: [string, number]): void {
        if (offset === 0 && length !== 0) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.BlockAbsence,
                at: "the header",
                field: lengthName,
                value: length,
                expected: `0, as ${offsetName} is 0`,
            });
        }

        if (offset !== 0 && length === 0) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.BlockAbsence,
                at: "the header",
                field: offsetName,
                value: offset,
                expected: `0, as ${lengthName} is 0`,
            });
        }
    }

    /**
     * Where the blocks lie. Each block is checked on its own first: inside the file, then the
     * metadata and the private block on a 4-byte boundary. Then one walk in the order of the
     * offsets, from the compressed data to the end of the file, checks what lies between them: no
     * overlap, the kinds in the order of §3, and nothing but null padding in the gaps.
     *
     * The compressed data has no offset of its own: it starts where the table directory ends, so
     * nothing can lie between the two, and a block that overlaps the directory overlaps the
     * compressed data too. An absent block, of offset and length 0 by now, takes no bytes, and the
     * walk skips it.
     */
    private checkLayout(woff2: Woff2): void {
        const [compressedData, ...optionalBlocks] = this.blocks(woff2);
        const fileSizeBytes = woff2.bytes.length;

        for (const block of [compressedData, ...optionalBlocks]) {
            const blockEnd = this.endOffset(block);

            if (blockEnd > fileSizeBytes) {
                throw BrokenWoff2.byRule(woff2.path, {
                    rule: Woff2Rule.BlockInFile,
                    at: block.name,
                    field: "end",
                    value: blockEnd,
                    expected: `at most ${fileSizeBytes}, the file size`,
                });
            }

            if (block.kind !== BlockKind.CompressedData && block.offset % Woff2FontValidator.ALIGNMENT_BYTES !== 0) {
                throw BrokenWoff2.byRule(woff2.path, {
                    rule: Woff2Rule.BlockAlignment,
                    at: block.name,
                    field: "offset",
                    value: block.offset,
                    expected: `a multiple of ${Woff2FontValidator.ALIGNMENT_BYTES}`,
                });
            }
        }

        let previous = compressedData;
        const blocksByOffset = optionalBlocks.filter((block) => block.length > 0).toSorted((left, right) => left.offset - right.offset);

        for (const block of blocksByOffset) {
            const previousEnd = this.endOffset(previous);

            if (block.offset < previousEnd) {
                throw BrokenWoff2.byRule(woff2.path, {
                    rule: Woff2Rule.NoOverlap,
                    at: block.name,
                    field: "offset",
                    value: block.offset,
                    expected: `at least ${previousEnd}, the end of ${previous.name}`,
                });
            }

            if (block.kind < previous.kind) {
                throw BrokenWoff2.byRule(woff2.path, {
                    rule: Woff2Rule.NoExtraneousData,
                    at: block.name,
                    field: "offset",
                    value: block.offset,
                    expected: `an offset before ${previous.name}`,
                });
            }

            // The metadata and the private block start on the 4-byte boundary after the block before
            // them (§6, §7).
            this.checkGap(woff2, previous, { at: block.name, field: "offset", offset: block.offset }, this.expectedPaddedEnd(previous));
            previous = block;
        }

        const fileEnd: GapEnd = { at: "the file", field: "size", offset: fileSizeBytes };

        // No padding follows the metadata when it is last (§6), and the private block ends the
        // file (§7). The compressed data that ends the file is padded by a rule of ours.
        if (previous.kind === BlockKind.CompressedData) {
            this.checkGap(woff2, previous, fileEnd, this.expectedPaddedEnd(previous));
        } else {
            this.checkGap(woff2, previous, fileEnd, this.expectedEnd(previous));
        }
    }

    /**
     * The gap from the end of `previous` to `next`, the next block or the end of the file, which is
     * to lie at `expected`. Longer, it holds extraneous data. Shorter, it lacks padding, and only
     * the compressed data that ends the file can lack it: every other block starts on a 4-byte
     * boundary at or after the end of the one before it. What lies in the gap is null padding.
     */
    private checkGap(woff2: Woff2, previous: Block, next: GapEnd, expected: ExpectedEnd): void {
        const previousEnd = this.endOffset(previous);

        if (next.offset < expected.offset) {
            throw BrokenWoff2.byRule(woff2.path, {
                rule: Woff2Rule.EndPadding,
                at: previous.name,
                field: "padding length",
                value: next.offset - previousEnd,
                expected: `${expected.offset - previousEnd}`,
            });
        }

        if (next.offset > expected.offset) {
            throw BrokenWoff2.byRule(woff2.path, {
                rule: Woff2Rule.NoExtraneousData,
                at: next.at,
                field: next.field,
                value: next.offset,
                expected: `${expected.offset}, ${expected.description}`,
            });
        }

        const padding = woff2.bytes.subarray(previousEnd, next.offset);

        if (padding.some((byte) => byte !== 0)) {
            throw BrokenWoff2.byRule(woff2.path, {
                rule: Woff2Rule.Padding,
                at: previous.name,
                field: "padding",
                value: this.hexBytes(padding),
                expected: this.hexBytes(new Uint8Array(padding.length)),
            });
        }
    }

    private expectedPaddedEnd(block: Block): ExpectedEnd {
        return {
            offset: NumberHelper.roundUp(this.endOffset(block), Woff2FontValidator.ALIGNMENT_BYTES),
            description: `the end of ${block.name} padded to ${Woff2FontValidator.ALIGNMENT_BYTES} bytes`,
        };
    }

    private expectedEnd(block: Block): ExpectedEnd {
        return { offset: this.endOffset(block), description: `the end of ${block.name}` };
    }

    private endOffset(block: Block): number {
        return block.offset + block.length;
    }

    /**
     * The compressed data, then the metadata and the private block. An absent block is among them
     * too: by the time the layout is checked, `checkBlockAbsence()` has made its offset and length
     * 0, and an empty block lies inside the file, on a 4-byte boundary, and is skipped by the walk.
     */
    private blocks({ header, directoryEnd }: Woff2): [Block, ...Array<Block>] {
        return [
            { kind: BlockKind.CompressedData, name: "the compressed data", offset: directoryEnd, length: header.totalCompressedSize },
            { kind: BlockKind.Metadata, name: "the metadata block", offset: header.metaOffset, length: header.metaLength },
            { kind: BlockKind.Private, name: "the private block", offset: header.privOffset, length: header.privLength },
        ];
    }

    /**
     * The tables by tag, cut from the decompressed stream in the order of the directory: each
     * takes its transformLength when transformed, its origLength otherwise (§5). The caps are
     * checked on the sum of those lengths before Brotli runs, and Brotli is given the sum as its
     * output limit.
     */
    private async decompressedTables(woff2: Woff2): Promise<Array<DecompressedTable>> {
        let streamSizeBytes = 0;

        for (const entry of woff2.entries) {
            streamSizeBytes += this.streamLengthBytes(entry);
        }

        this.checkDecompressedSize(woff2, streamSizeBytes);

        const stream = await this.decompressed(woff2, streamSizeBytes);
        const tables: Array<DecompressedTable> = [];
        let offset = 0;

        for (const entry of woff2.entries) {
            tables.push({ entry: entry, bytes: stream.subarray(offset, offset + this.streamLengthBytes(entry)) });
            offset += this.streamLengthBytes(entry);
        }

        return tables;
    }

    private streamLengthBytes(entry: TableEntry): number {
        return entry.transformLength ?? entry.origLength;
    }

    private checkDecompressedSize({ path, bytes }: Woff2, streamSizeBytes: number): void {
        const violation = { at: "the table directory", field: "sum of the table lengths", value: streamSizeBytes };

        if (streamSizeBytes > Woff2FontValidator.DECODER_BUFFER_SIZE_BYTES) {
            throw BrokenWoff2.byRule(path, {
                ...violation,
                rule: Woff2Rule.MaxDecompressedSize,
                expected: `at most ${Woff2FontValidator.DECODER_BUFFER_SIZE_BYTES}`,
            });
        }

        const maxSizeBytes = Woff2FontValidator.MAX_COMPRESSION_RATIO * bytes.length;

        if (streamSizeBytes > maxSizeBytes) {
            throw BrokenWoff2.byRule(path, {
                ...violation,
                rule: Woff2Rule.MaxCompressionRatio,
                expected: `at most ${maxSizeBytes}, ${Woff2FontValidator.MAX_COMPRESSION_RATIO} times the file size`,
            });
        }
    }

    /**
     * The compressed data has to be one Brotli stream and nothing after it: `brotliDecompress`
     * stops at the end of the stream and drops the rest, so the consumed input is compared with
     * totalCompressedSize. A stream longer than the sum fails on `maxOutputLength`, which Node
     * refuses to take as 0: an empty sum lets one byte through, and the length check catches it.
     */
    private async decompressed({ path, bytes, header, directoryEnd }: Woff2, streamSizeBytes: number): Promise<Uint8Array> {
        const compressed = bytes.subarray(directoryEnd, directoryEnd + header.totalCompressedSize);
        const violation = {
            rule: Woff2Rule.Brotli,
            at: "the compressed data",
            expected: `a Brotli stream of ${header.totalCompressedSize} bytes decompressing to ${streamSizeBytes}`,
        };
        let decompressed: Decompressed;

        try {
            decompressed = (await brotliDecompress(compressed, {
                maxOutputLength: Math.max(streamSizeBytes, 1),
                info: true,
            })) as unknown as Decompressed;
        } catch (error) {
            throw BrokenWoff2.byBrotliError(
                path,
                { ...violation, field: "decompress error", value: JSON.stringify((error as Error).message) },
                error as Error,
            );
        }

        if (decompressed.buffer.length !== streamSizeBytes) {
            throw BrokenWoff2.byRule(path, { ...violation, field: "decompressed length", value: decompressed.buffer.length });
        }

        if (decompressed.engine.bytesWritten !== header.totalCompressedSize) {
            throw BrokenWoff2.byRule(path, { ...violation, field: "Brotli stream length", value: decompressed.engine.bytesWritten });
        }

        return decompressed.buffer;
    }

    /**
     * The tables of the sfnt the WOFF2 rebuilds, in the order of the directory: a plain table as it
     * is, glyf and loca rebuilt from the transformed glyf, and hmtx from the transformed hmtx. The
     * directory has made glyf and loca transformed together, and a transformed hmtx lie beside a
     * transformed glyf. The header of the transformed glyf, the origLength of the transformed loca
     * and the flags of the transformed hmtx are checked before any glyph record is read.
     */
    private sfntTables(fontPath: string, tables: ReadonlyArray<DecompressedTable>): Array<SfntTable> {
        const glyf = tables.find((table) => table.entry.tag === TableTag.Glyf);
        const loca = tables.find((table) => table.entry.tag === TableTag.Loca);
        const hmtx = tables.find((table) => table.entry.tag === TableTag.Hmtx);

        if (glyf?.entry.transformLength === undefined || loca === undefined) {
            return tables.map((table) => ({ tag: table.entry.tag, bytes: table.bytes }));
        }

        const reconstructor = new GlyfReconstructor(fontPath, glyf.bytes);

        this.checkTransformedLoca(fontPath, loca.entry, reconstructor);

        const transformedHmtx = hmtx?.entry.transformLength === undefined ? undefined : this.transformedHmtx(fontPath, hmtx.bytes, tables);
        const reconstructed = reconstructor.reconstruct(transformedHmtx);

        return tables.map((table) => ({ tag: table.entry.tag, bytes: this.rebuiltBytes(table, reconstructed) }));
    }

    private rebuiltBytes(table: DecompressedTable, reconstructed: ReconstructedTables): Uint8Array {
        switch (table.entry.tag) {
            case TableTag.Glyf:
                return reconstructed.glyf;
            case TableTag.Loca:
                return reconstructed.loca;
            case TableTag.Hmtx:
                return reconstructed.hmtx ?? table.bytes;
            default:
                return table.bytes;
        }
    }

    private checkTransformedLoca(fontPath: string, locaEntry: TableEntry, reconstructor: GlyfReconstructor): void {
        const { numGlyphs, indexFormat, locaOffsetSizeBytes: offsetSizeBytes } = reconstructor;
        const locaSizeBytes = (numGlyphs + 1) * offsetSizeBytes;

        if (locaEntry.origLength !== locaSizeBytes) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.LocaTransform,
                at: BrokenWoff2.tableName(TableTag.Loca),
                field: "origLength",
                value: locaEntry.origLength,
                expected: `${locaSizeBytes}, (numGlyphs ${numGlyphs} + 1) × ${offsetSizeBytes} for indexFormat ${indexFormat} of table "glyf"`,
            });
        }
    }

    /**
     * The transformed hmtx with hhea, once its flags pass rule `HmtxTransform`. `GlyfReconstructor`
     * checks rule `TransformedHmtx`: hhea and numberOfHMetrics against the glyph count, and the
     * length of the table.
     */
    private transformedHmtx(fontPath: string, hmtx: Uint8Array, tables: ReadonlyArray<DecompressedTable>): TransformedHmtx {
        this.checkHmtxFlags(fontPath, hmtx);

        return { bytes: hmtx, hhea: tables.find((table) => table.entry.tag === TableTag.Hhea)?.bytes };
    }

    /**
     * The size of the sfnt the decoder writes: the 12-byte header, a 16-byte table record per
     * table, then each table padded to 4 bytes (`ReconstructFont()` in `woff2_dec.cc` 1.0.2).
     */
    private checkSfntSize(fontPath: string, tables: ReadonlyArray<SfntTable>): void {
        let sfntSizeBytes = Woff2FontValidator.SFNT_HEADER_SIZE_BYTES + tables.length * Woff2FontValidator.SFNT_TABLE_RECORD_SIZE_BYTES;

        for (const table of tables) {
            sfntSizeBytes += NumberHelper.roundUp(table.bytes.length, Woff2FontValidator.ALIGNMENT_BYTES);
        }

        if (sfntSizeBytes > Woff2FontValidator.DECODER_BUFFER_SIZE_BYTES) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.MaxSfntSize,
                at: "the rebuilt sfnt",
                field: "size",
                value: sfntSizeBytes,
                expected: `at most ${Woff2FontValidator.DECODER_BUFFER_SIZE_BYTES}`,
            });
        }
    }

    private checkHmtxFlags(fontPath: string, hmtx: Uint8Array): void {
        const at = BrokenWoff2.tableName(TableTag.Hmtx);

        const flags = hmtx[0];

        if (flags === undefined) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.HmtxTransform,
                at: at,
                field: "transformLength",
                value: 0,
                expected: "at least 1, for the flags byte",
            });
        }

        if ((flags & Woff2FontValidator.HMTX_FLAG_BITS) === 0 || (flags & Woff2FontValidator.HMTX_RESERVED_BITS) !== 0) {
            throw BrokenWoff2.byRule(fontPath, {
                rule: Woff2Rule.HmtxTransform,
                at: at,
                field: "flags",
                value: this.hexBytes(hmtx.subarray(0, 1)),
                expected: "bit 0 or bit 1 set, bits 2–7 clear",
            });
        }
    }

    private hex(value: number): string {
        return `0x${value.toString(16).padStart(8, "0")}`;
    }

    private hexBytes(bytes: Uint8Array): string {
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    }
}
