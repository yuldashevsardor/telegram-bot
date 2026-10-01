import { inject, injectable } from "inversify";
import { promisify } from "util";
import { inflate as inflateOrigin } from "zlib";
import { SfntTableDirectory } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";
import type { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import { BrokenWoff, NotWoff } from "app/font-convertor/validator/woff/woff-font-validator.errors";
import type {
    Block,
    ExpectedEnd,
    GapEnd,
    InflatedTable,
    TableEntry,
    Woff,
    WoffHeader,
} from "app/font-convertor/validator/woff/woff-font-validator.types";
import { BlockKind, WoffRule } from "app/font-convertor/validator/woff/woff-font-validator.types";
import type { FontValidator } from "app/font-convertor/validator/font-validator";
import { FileHelper } from "app/shared/fs/file-helper";
import { Tokens } from "app/shared/tokens";

const inflate = promisify(inflateOrigin);

/**
 * What `inflate` gives with `info: true`: the engine as well as the output. Its `bytesWritten`
 * counts the input the engine consumed, and it stops at the end of the zlib stream. The types of
 * Node describe the output alone.
 */
type Inflated = {
    buffer: Buffer;
    engine: { bytesWritten: number };
};

/**
 * Checks the WOFF container against W3C Recommendation "WOFF File Format 1.0" (13 December 2012):
 * the header, the table directory, the tables and the bounds of the metadata and private blocks.
 * The standard checks the packaging only: it "does not guarantee that the actual font data packaged
 * in a valid WOFF container is in fact correct and usable" (§3). So the sfnt the tables were packed
 * from is rebuilt in memory and checked by `SfntFontValidator`, whose answer passes through as is.
 *
 * Deliberately not checked:
 * - `head.checkSumAdjustment` of the sfnt rebuilt from the tables (§5, W3C test
 *   directory-origCheckSum-002). It fails for 1494 of 5405 real fonts, among them Font Awesome 4.7
 *   and all of `@fontsource/*`: their generators stored the tables in tag order against §6, which
 *   changes the rebuilt directory. fontforge converts them.
 * - The content of the metadata block: zlib, `metaOrigLength`, XML, the schema. §7: "A conforming
 *   user agent MUST ignore an invalid metadata block". Only its bounds are checked, and it is never
 *   inflated.
 * - The flavor against the outline tables (W3C tests header-flavor-001/002). The flavor is the
 *   version of the rebuilt sfnt, and `SfntFontValidator` does not tie the version to the outlines.
 */
@injectable()
export class WoffFontValidator implements FontValidator {
    private static readonly SIGNATURE = 0x774f4646;
    private static readonly HEADER_SIZE_BYTES = 44;
    private static readonly DIRECTORY_ENTRY_SIZE_BYTES = 20;
    // The offsets of the header fields (§4). majorVersion and minorVersion, at 20 and 22, are not
    // read: they "have no effect on font loading".
    private static readonly HEADER_FIELD_OFFSETS = {
        signature: 0,
        flavor: 4,
        length: 8,
        numTables: 12,
        reserved: 14,
        totalSfntSize: 16,
        metaOffset: 24,
        metaLength: 28,
        metaOrigLength: 32,
        privOffset: 36,
        privLength: 40,
    };
    // The offsets of the fields in a table directory entry (§5), after the tag that opens it.
    private static readonly ENTRY_FIELD_OFFSETS = { offset: 4, compLength: 8, origLength: 12, origChecksum: 16 };
    // Tables are aligned and padded to it (§5), and the private block is aligned (§8).
    private static readonly ALIGNMENT_BYTES = 4;
    // The blocks that start on that boundary, with the rule each breaks off it.
    private static readonly ALIGNMENT_RULES: ReadonlyMap<BlockKind, WoffRule> = new Map([
        [BlockKind.Table, WoffRule.TableAlignment],
        [BlockKind.Private, WoffRule.PrivateAlignment],
    ]);
    private static readonly HEAD_TAG = "head";
    private static readonly CHECKSUM_ADJUSTMENT_OFFSET = 8;
    private static readonly CHECKSUM_ADJUSTMENT_END = 12;
    private static readonly CHECKSUM_WORD_SIZE_BYTES = 4;
    // Checked on the header field before any table is inflated. That is enough: rule 6 ties the
    // field to the sum of origLength, and a table never inflates past its origLength.
    // A 589 168-byte WOFF with a 512 MiB table of zeros took the process to 1090 MB RSS on
    // inflating; fontforge ignores such a table.
    private static readonly MAX_SFNT_SIZE_BYTES = 32 * 1024 * 1024;

    public constructor(@inject<SfntFontValidator>(Tokens.Font.Validator.Sfnt) private readonly sfntFontValidator: SfntFontValidator) {}

    /**
     * Throws when the file is not a valid WOFF font. The answers about the container are
     * subclasses of `InvalidWoffFont`: `NotWoff` for a file shorter than the header or without the
     * signature, `BrokenWoff` for the first broken rule, checked in this order: the header, the
     * table directory, the fields of absent blocks, the layout of the blocks, then the tables one by
     * one in directory order. A valid container gets the answer of `SfntFontValidator` on the sfnt
     * rebuilt from its tables, a subclass of `InvalidSfntFont` naming the WOFF file. A file that
     * cannot be read throws `ReadFailed` of `FileHelper` instead: an I/O failure, not a verdict on
     * the font.
     */
    public async validate(fontPath: string): Promise<void> {
        const bytes = await FileHelper.read(fontPath);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        if (bytes.length < WoffFontValidator.HEADER_SIZE_BYTES) {
            throw NotWoff.bySize(fontPath, bytes.length, WoffFontValidator.HEADER_SIZE_BYTES);
        }

        const signature = view.getUint32(WoffFontValidator.HEADER_FIELD_OFFSETS.signature);

        if (signature !== WoffFontValidator.SIGNATURE) {
            throw NotWoff.bySignature(fontPath, this.hex(signature), `${this.hex(WoffFontValidator.SIGNATURE)} ("wOFF")`);
        }

        const header = this.readHeader(view);

        this.checkHeader(fontPath, header, bytes.length);

        const woff: Woff = { path: fontPath, bytes: bytes, header: header, entries: this.readDirectory(view, header.numTables) };

        this.checkDirectory(woff);
        this.checkBlockAbsence(woff);
        this.checkLayout(woff);

        const tables: Array<InflatedTable> = [];

        for (const entry of woff.entries) {
            tables.push({ entry: entry, bytes: await this.checkedTable(woff, entry) });
        }

        this.sfntFontValidator.validateBytes(fontPath, this.sfnt(woff, tables));
    }

    private readHeader(view: DataView): WoffHeader {
        const fields = WoffFontValidator.HEADER_FIELD_OFFSETS;

        return {
            flavor: view.getUint32(fields.flavor),
            length: view.getUint32(fields.length),
            numTables: view.getUint16(fields.numTables),
            reserved: view.getUint16(fields.reserved),
            totalSfntSize: view.getUint32(fields.totalSfntSize),
            metaOffset: view.getUint32(fields.metaOffset),
            metaLength: view.getUint32(fields.metaLength),
            metaOrigLength: view.getUint32(fields.metaOrigLength),
            privOffset: view.getUint32(fields.privOffset),
            privLength: view.getUint32(fields.privLength),
        };
    }

    private checkHeader(fontPath: string, header: WoffHeader, fileSizeBytes: number): void {
        const at = "the header";

        if (!SFNT_VERSIONS.includes(header.flavor)) {
            const expected = `one of ${SFNT_VERSIONS.map((version) => this.hex(version)).join(", ")}`;

            throw BrokenWoff.byRule(fontPath, {
                rule: WoffRule.Flavor,
                at: at,
                field: "flavor",
                value: this.hex(header.flavor),
                expected: expected,
            });
        }

        if (header.length !== fileSizeBytes) {
            throw BrokenWoff.byRule(fontPath, {
                rule: WoffRule.Length,
                at: at,
                field: "length",
                value: header.length,
                expected: `${fileSizeBytes}, the file size`,
            });
        }

        if (header.numTables === 0) {
            throw BrokenWoff.byRule(fontPath, {
                rule: WoffRule.TablesPresent,
                at: at,
                field: "numTables",
                value: header.numTables,
                expected: "at least 1",
            });
        }

        if (header.reserved !== 0) {
            throw BrokenWoff.byRule(fontPath, {
                rule: WoffRule.Reserved,
                at: at,
                field: "reserved",
                value: header.reserved,
                expected: "0",
            });
        }

        const directoryEnd = this.directoryEnd(header.numTables);

        if (fileSizeBytes < directoryEnd) {
            throw BrokenWoff.byRule(fontPath, {
                rule: WoffRule.DirectoryInFile,
                at: "the file",
                field: "size",
                value: fileSizeBytes,
                expected: `at least ${directoryEnd} for ${header.numTables} directory entries`,
            });
        }
    }

    private readDirectory(view: DataView, numTables: number): Array<TableEntry> {
        const entries: Array<TableEntry> = [];

        for (let index = 0; index < numTables; index++) {
            const entryOffset = WoffFontValidator.HEADER_SIZE_BYTES + index * WoffFontValidator.DIRECTORY_ENTRY_SIZE_BYTES;

            const fields = WoffFontValidator.ENTRY_FIELD_OFFSETS;

            entries.push({
                tag: this.tag(view, entryOffset),
                offset: view.getUint32(entryOffset + fields.offset),
                compLength: view.getUint32(entryOffset + fields.compLength),
                origLength: view.getUint32(entryOffset + fields.origLength),
                origChecksum: view.getUint32(entryOffset + fields.origChecksum),
            });
        }

        return entries;
    }

    /**
     * The directory itself, then the sizes it gives: totalSfntSize is checked against it, and the
     * cap after that, so the cap stands on a field the directory has confirmed.
     */
    private checkDirectory({ path, header, entries }: Woff): void {
        let sfntSizeBytes = SfntTableDirectory.HEADER_SIZE_BYTES + SfntTableDirectory.RECORD_SIZE_BYTES * header.numTables;
        let previous: TableEntry | undefined;

        for (const entry of entries) {
            if (previous !== undefined && entry.tag <= previous.tag) {
                throw BrokenWoff.byRule(path, {
                    rule: WoffRule.AscendingTags,
                    at: this.tableName(entry),
                    field: "tag",
                    value: JSON.stringify(entry.tag),
                    expected: `a tag after ${JSON.stringify(previous.tag)}`,
                });
            }

            if (entry.compLength > entry.origLength) {
                throw BrokenWoff.byRule(path, {
                    rule: WoffRule.CompressedLength,
                    at: this.tableName(entry),
                    field: "compLength",
                    value: entry.compLength,
                    expected: `at most ${entry.origLength}, the origLength`,
                });
            }

            sfntSizeBytes += this.padded(entry.origLength, WoffFontValidator.ALIGNMENT_BYTES);
            previous = entry;
        }

        const at = "the header";

        if (header.totalSfntSize !== sfntSizeBytes) {
            throw BrokenWoff.byRule(path, {
                rule: WoffRule.TotalSfntSize,
                at: at,
                field: "totalSfntSize",
                value: header.totalSfntSize,
                expected: `${sfntSizeBytes}`,
            });
        }

        if (header.totalSfntSize > WoffFontValidator.MAX_SFNT_SIZE_BYTES) {
            throw BrokenWoff.byRule(path, {
                rule: WoffRule.MaxSfntSize,
                at: at,
                field: "totalSfntSize",
                value: header.totalSfntSize,
                expected: `at most ${WoffFontValidator.MAX_SFNT_SIZE_BYTES}`,
            });
        }
    }

    private checkBlockAbsence({ path, header }: Woff): void {
        this.checkAbsence(path, ["metaOffset", header.metaOffset], ["metaLength", header.metaLength]);

        if (header.metaOffset === 0 && header.metaOrigLength !== 0) {
            throw BrokenWoff.byRule(path, {
                rule: WoffRule.BlockAbsence,
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
            throw BrokenWoff.byRule(fontPath, {
                rule: WoffRule.BlockAbsence,
                at: "the header",
                field: lengthName,
                value: length,
                expected: `0, as ${offsetName} is 0`,
            });
        }

        if (offset !== 0 && length === 0) {
            throw BrokenWoff.byRule(fontPath, {
                rule: WoffRule.BlockAbsence,
                at: "the header",
                field: offsetName,
                value: offset,
                expected: `0, as ${lengthName} is 0`,
            });
        }
    }

    /**
     * Where the blocks lie. Each block is checked on its own first: inside the file, then aligned.
     * Then one walk in the order of the offsets, from the end of the directory to the end of the
     * file, checks what lies between them: no overlap, the kinds in the order of §3, and nothing
     * but zero padding in the gaps.
     *
     * An empty block takes no bytes, so it overlaps nothing and leaves no gap: the walk skips it.
     * That is an absent metadata or private block, or a table of compLength 0. Walked, such a table
     * at the offset of another one would count as inside that table or before it depending on the
     * order of the directory, that is on its tag.
     */
    private checkLayout(woff: Woff): void {
        const blocks = this.blocks(woff);
        const fileSizeBytes = woff.bytes.length;

        for (const block of blocks) {
            const blockEnd = this.endOffset(block);

            if (blockEnd > fileSizeBytes) {
                throw BrokenWoff.byRule(woff.path, {
                    rule: WoffRule.BlockInFile,
                    at: block.name,
                    field: "end",
                    value: blockEnd,
                    expected: `at most ${fileSizeBytes}, the file size`,
                });
            }

            const alignmentRule = WoffFontValidator.ALIGNMENT_RULES.get(block.kind);

            if (alignmentRule !== undefined && block.offset % WoffFontValidator.ALIGNMENT_BYTES !== 0) {
                throw BrokenWoff.byRule(woff.path, {
                    rule: alignmentRule,
                    at: block.name,
                    field: "offset",
                    value: block.offset,
                    expected: `a multiple of ${WoffFontValidator.ALIGNMENT_BYTES}`,
                });
            }
        }

        let previous: Block = {
            kind: BlockKind.Directory,
            name: "the table directory",
            offset: 0,
            length: this.directoryEnd(woff.header.numTables),
        };

        const blocksByOffset = blocks.filter((block) => block.length > 0).toSorted((left, right) => left.offset - right.offset);

        for (const block of blocksByOffset) {
            const previousEnd = this.endOffset(previous);

            if (block.offset < previousEnd) {
                throw BrokenWoff.byRule(woff.path, {
                    rule: WoffRule.NoOverlap,
                    at: block.name,
                    field: "offset",
                    value: block.offset,
                    expected: `at least ${previousEnd}, the end of ${previous.name}`,
                });
            }

            if (block.kind < previous.kind) {
                throw BrokenWoff.byRule(woff.path, {
                    rule: WoffRule.NoExtraneousData,
                    at: block.name,
                    field: "offset",
                    value: block.offset,
                    expected: `an offset before ${previous.name}`,
                });
            }

            // Every block starts on a 4-byte boundary after what precedes it: the tables and the
            // metadata right after the padded tables (§5, §7), the private block by §8.
            this.checkGap(woff, previous, { at: block.name, field: "offset", offset: block.offset }, this.expectedPaddedEnd(previous));
            previous = block;
        }

        const fileEnd: GapEnd = { at: "the file", field: "size", offset: woff.bytes.length };

        // A table is padded, the last one too (§5). No padding follows the metadata when it is last
        // (§7), and the private block ends the file (§8).
        if (previous.kind === BlockKind.Table) {
            this.checkGap(woff, previous, fileEnd, this.expectedPaddedEnd(previous));
        } else {
            this.checkGap(woff, previous, fileEnd, this.expectedEnd(previous));
        }
    }

    /**
     * The gap from the end of `previous` to `next`, the next block or the end of the file, which is
     * to lie at `expected`: shorter, it lacks padding; longer, it holds extraneous data. What lies
     * in it is padding, all zero bytes.
     */
    private checkGap(woff: Woff, previous: Block, next: GapEnd, expected: ExpectedEnd): void {
        const previousEnd = this.endOffset(previous);

        if (next.offset < expected.offset) {
            throw BrokenWoff.byRule(woff.path, {
                rule: WoffRule.Padding,
                at: previous.name,
                field: "padding length",
                value: next.offset - previousEnd,
                expected: `${expected.offset - previousEnd}`,
            });
        }

        if (next.offset > expected.offset) {
            throw BrokenWoff.byRule(woff.path, {
                rule: WoffRule.NoExtraneousData,
                at: next.at,
                field: next.field,
                value: next.offset,
                expected: `${expected.offset}, ${expected.description}`,
            });
        }

        const padding = woff.bytes.subarray(previousEnd, next.offset);

        if (padding.some((byte) => byte !== 0)) {
            throw BrokenWoff.byRule(woff.path, {
                rule: WoffRule.Padding,
                at: previous.name,
                field: "padding",
                value: this.hexBytes(padding),
                expected: this.hexBytes(new Uint8Array(padding.length)),
            });
        }
    }

    private expectedPaddedEnd(block: Block): ExpectedEnd {
        return {
            offset: this.padded(this.endOffset(block), WoffFontValidator.ALIGNMENT_BYTES),
            description: `the end of ${block.name} padded to ${WoffFontValidator.ALIGNMENT_BYTES} bytes`,
        };
    }

    private expectedEnd(block: Block): ExpectedEnd {
        return { offset: this.endOffset(block), description: `the end of ${block.name}` };
    }

    private endOffset(block: Block): number {
        return block.offset + block.length;
    }

    /**
     * The uncompressed table, once its checksum matches.
     */
    private async checkedTable(woff: Woff, entry: TableEntry): Promise<Uint8Array> {
        const table = await this.uncompressed(woff, entry);
        const checksum = this.checksum(entry.tag, table);

        if (entry.origChecksum !== checksum) {
            throw BrokenWoff.byRule(woff.path, {
                rule: WoffRule.TableChecksum,
                at: this.tableName(entry),
                field: "origChecksum",
                value: this.hex(entry.origChecksum),
                expected: this.hex(checksum),
            });
        }

        return table;
    }

    /**
     * The sfnt the tables were packed from, as §5 and §6 rebuild it: the flavor as the version, the
     * directory in tag order, which the WOFF directory already is, each record with origChecksum
     * and origLength, and the tables in the order of their WOFF offsets, each padded to 4 bytes
     * with zeros. totalSfntSize is its size: rule 6 has confirmed it against the directory.
     */
    private sfnt({ header }: Woff, tables: ReadonlyArray<InflatedTable>): Uint8Array {
        const rebuiltSfnt = new Uint8Array(header.totalSfntSize);
        const view = new DataView(rebuiltSfnt.buffer);
        const headerFields = SfntTableDirectory.HEADER_FIELD_OFFSETS_BYTES;
        const recordSizeBytes = SfntTableDirectory.RECORD_SIZE_BYTES;
        const numTables = tables.length;
        // entrySelector is the exponent of the largest power of 2 not greater than numTables, and
        // searchRange is that power of 2 times the record size, in bytes. From 4096 tables on it does
        // not fit its 16 bits and setUint16 wraps it: OpenType gives no value for that case, and
        // SfntFontValidator does not read the field.
        const entrySelector = Math.floor(Math.log2(numTables));
        const searchRangeBytes = 2 ** entrySelector * recordSizeBytes;

        view.setUint32(headerFields.version, header.flavor);
        view.setUint16(headerFields.numTables, numTables);
        view.setUint16(headerFields.searchRange, searchRangeBytes);
        view.setUint16(headerFields.entrySelector, entrySelector);
        view.setUint16(headerFields.rangeShift, numTables * recordSizeBytes - searchRangeBytes);

        const recordFields = SfntTableDirectory.RECORD_FIELD_OFFSETS_BYTES;
        const withRecordOffsets = tables.map((inflated, index) => ({
            ...inflated,
            recordOffsetBytes: SfntTableDirectory.HEADER_SIZE_BYTES + index * recordSizeBytes,
        }));
        const inStorageOrder = withRecordOffsets.toSorted((left, right) => left.entry.offset - right.entry.offset);
        let tableOffsetBytes = SfntTableDirectory.HEADER_SIZE_BYTES + numTables * recordSizeBytes;

        for (const { entry, bytes, recordOffsetBytes } of inStorageOrder) {
            rebuiltSfnt.set(Buffer.from(entry.tag, "latin1"), recordOffsetBytes);
            view.setUint32(recordOffsetBytes + recordFields.checksum, entry.origChecksum);
            view.setUint32(recordOffsetBytes + recordFields.offset, tableOffsetBytes);
            view.setUint32(recordOffsetBytes + recordFields.length, entry.origLength);
            rebuiltSfnt.set(bytes, tableOffsetBytes);
            tableOffsetBytes += this.padded(entry.origLength, WoffFontValidator.ALIGNMENT_BYTES);
        }

        return rebuiltSfnt;
    }

    /**
     * A table is stored compressed when compLength is less than origLength (§5). It then has to be
     * one zlib stream and nothing after it: `inflate` stops at the end of the stream and drops the
     * rest, so the consumed input is compared with compLength.
     */
    private async uncompressed({ path, bytes }: Woff, entry: TableEntry): Promise<Uint8Array> {
        const stored = bytes.subarray(entry.offset, entry.offset + entry.compLength);

        if (entry.compLength === entry.origLength) {
            return stored;
        }

        const violation = {
            rule: WoffRule.Zlib,
            at: this.tableName(entry),
            expected: `a zlib stream of ${entry.compLength} bytes inflating to ${entry.origLength}`,
        };
        let inflated: Inflated;

        try {
            inflated = (await inflate(stored, { maxOutputLength: entry.origLength, info: true })) as unknown as Inflated;
        } catch (error) {
            throw BrokenWoff.byZlibError(
                path,
                { ...violation, field: "inflate error", value: JSON.stringify((error as Error).message) },
                error as Error,
            );
        }

        if (inflated.buffer.length !== entry.origLength) {
            throw BrokenWoff.byRule(path, { ...violation, field: "inflated length", value: inflated.buffer.length });
        }

        if (inflated.engine.bytesWritten !== entry.compLength) {
            throw BrokenWoff.byRule(path, { ...violation, field: "zlib stream length", value: inflated.engine.bytesWritten });
        }

        return inflated.buffer;
    }

    /**
     * The sfnt table checksum: the sum of the table as big-endian 32-bit words, padded with zeros,
     * modulo 2^32. In `head`, checkSumAdjustment counts as 0: the whole-font checksum is stored
     * there, so it cannot be part of the table's own.
     */
    private checksum(tag: string, table: Uint8Array): number {
        const padded = new Uint8Array(this.padded(table.length, WoffFontValidator.CHECKSUM_WORD_SIZE_BYTES));

        padded.set(table);

        if (tag === WoffFontValidator.HEAD_TAG) {
            padded.fill(0, WoffFontValidator.CHECKSUM_ADJUSTMENT_OFFSET, WoffFontValidator.CHECKSUM_ADJUSTMENT_END);
        }

        const view = new DataView(padded.buffer);
        let sum = 0;

        for (let offset = 0; offset < padded.length; offset += WoffFontValidator.CHECKSUM_WORD_SIZE_BYTES) {
            sum = (sum + view.getUint32(offset)) >>> 0;
        }

        return sum;
    }

    /**
     * The tables, then the metadata and the private block. An absent block is among them too: by
     * the time the layout is checked, rule 7 has made its offset and length 0, and an empty block
     * lies inside the file, on a 4-byte boundary, and is skipped by the walk.
     */
    private blocks({ header, entries }: Woff): Array<Block> {
        const tables: Array<Block> = entries.map((entry) => ({
            kind: BlockKind.Table,
            name: this.tableName(entry),
            offset: entry.offset,
            length: entry.compLength,
        }));

        return [
            ...tables,
            { kind: BlockKind.Metadata, name: "the metadata block", offset: header.metaOffset, length: header.metaLength },
            { kind: BlockKind.Private, name: "the private block", offset: header.privOffset, length: header.privLength },
        ];
    }

    private directoryEnd(numTables: number): number {
        return WoffFontValidator.HEADER_SIZE_BYTES + numTables * WoffFontValidator.DIRECTORY_ENTRY_SIZE_BYTES;
    }

    /**
     * Rounded up to a multiple of `unitBytes`. Not with a bit mask: the operands of JavaScript
     * bitwise operators are 32-bit signed, and a length read from the file may be up to 2^32 - 1.
     */
    private padded(lengthBytes: number, unitBytes: number): number {
        return Math.ceil(lengthBytes / unitBytes) * unitBytes;
    }

    private tag(view: DataView, offset: number): string {
        return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    }

    private tableName(entry: TableEntry): string {
        return `table ${JSON.stringify(entry.tag)}`;
    }

    private hex(value: number): string {
        return `0x${value.toString(16).padStart(8, "0")}`;
    }

    private hexBytes(bytes: Uint8Array): string {
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    }
}
