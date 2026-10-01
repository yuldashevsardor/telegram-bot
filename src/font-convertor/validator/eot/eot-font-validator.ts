import { injectable } from "inversify";
import { EotHeader } from "app/font-convertor/eot-header/eot-header";
import { InvalidEot } from "app/font-convertor/eot-header/eot-header.errors";
import type { EotBlock } from "app/font-convertor/eot-header/eot-header.types";
import { SfntReader } from "app/font-convertor/eot-packer/sfnt-reader/sfnt-reader";
import { InvalidSfnt } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.errors";
import { BrokenEot, NotEot } from "app/font-convertor/validator/eot/eot-font-validator.errors";
import type { EotBlocks, NamedBlock, RootStringCheck } from "app/font-convertor/validator/eot/eot-font-validator.types";
import { EotRule } from "app/font-convertor/validator/eot/eot-font-validator.types";
import type { FontValidator } from "app/font-convertor/validator/font-validator";
import { FileHelper } from "app/shared/fs/file-helper";

/**
 * Checks the EOT envelope against W3C Member Submission "Embedded OpenType (EOT) File Format"
 * (5 March 2008): the fixed part of the header, the blocks of its version and that the font follows
 * them to the end of the file. The header is read through `EotHeader`, the parse the codec reads
 * too. The enclosed font gets the check the codec makes on unpacking, `SfntReader.validate`.
 *
 * Deliberately not checked, as the submission gives a reader no rule for them:
 * - The fields that copy the enclosed font: FontPANOSE, Italic, Weight, fsType, UnicodeRange1..4,
 *   CodePageRange1..2, CheckSumAdjustment and the four names. The domain discards the header on
 *   unpacking, and 25 of 247 uncompressed real files disagree with their font (11 on fsType, 14 on
 *   UnicodeRange, 1 on CheckSumAdjustment), the fixture too: ttf2eot writes fsType 0.
 * - Flag bits the submission does not list (§4.2 forbids none), TTEMBED_EMBEDEUDC against the
 *   version, SignatureSize, which "should" be 0, the values of Italic and Charset, and whether the
 *   names are well-formed UTF-16.
 * - The RootString URLs and the fsType permissions: §2.3 puts both on a user agent displaying a
 *   page, and the domain converts files.
 */
@injectable()
export class EotFontValidator implements FontValidator {
    private static readonly ROOT_STRING_CHECKSUM_KEY = 0x50475342;
    private static readonly UNSUPPORTED_FLAGS = EotHeader.TTEMBED_TTCOMPRESSED | EotHeader.TTEMBED_XORENCRYPTDATA;
    private static readonly UTF16_CHARACTER_SIZE_BYTES = 2;
    private static readonly USHORT_HEX_DIGITS = 4;
    private static readonly ULONG_HEX_DIGITS = 8;

    /**
     * Throws when the file is not a valid EOT font. The answers are subclasses of `InvalidEotFont`:
     * `NotEot` for a file shorter than the fixed part of the header or without the MagicNumber,
     * `BrokenEot` for the first broken rule, checked in this order: the fixed part (EOTSize, the
     * version, the reserved fields), where the blocks of the header and the font lie, the values in
     * the blocks (the paddings, the sizes of the names, RootStringCheckSum), the flags, then the
     * enclosed font. The layout goes before the values: a block read from the wrong place would
     * name a padding that is only a byte of a neighbour. A file that cannot be read throws
     * `ReadFailed` of `FileHelper` instead: an I/O failure, not a verdict on the font.
     */
    public async validate(fontPath: string): Promise<void> {
        const bytes = await FileHelper.read(fontPath);

        if (bytes.length < EotHeader.FIXED_SIZE_BYTES) {
            throw NotEot.bySize(fontPath, bytes.length, EotHeader.FIXED_SIZE_BYTES);
        }

        const header = new EotHeader(bytes);

        if (header.magicNumber !== EotHeader.MAGIC_NUMBER) {
            throw NotEot.byMagicNumber(
                fontPath,
                this.hex(header.magicNumber, EotFontValidator.USHORT_HEX_DIGITS),
                this.hex(EotHeader.MAGIC_NUMBER, EotFontValidator.USHORT_HEX_DIGITS),
            );
        }

        this.checkFixedPart(fontPath, header, bytes.length);

        const blocks = this.readBlocks(fontPath, header, bytes.length);

        this.checkLayout(fontPath, header, blocks, bytes.length);
        this.checkBlocks(fontPath, blocks);
        this.checkRootStringCheckSum(fontPath, bytes, blocks.rootStringCheck);
        this.checkFlags(fontPath, header);
        this.checkFontData(fontPath, bytes.subarray(blocks.endOffset));
    }

    private checkFixedPart(fontPath: string, header: EotHeader, fileSizeBytes: number): void {
        const at = "the header";

        if (header.eotSizeBytes !== fileSizeBytes) {
            throw BrokenEot.byRule(fontPath, {
                rule: EotRule.EotSize,
                at: at,
                field: "EOTSize",
                value: header.eotSizeBytes,
                expected: `${fileSizeBytes}, the file size`,
            });
        }

        if (!EotHeader.VERSIONS.includes(header.version)) {
            const expected = `one of ${EotHeader.VERSIONS.map((version) => this.hex(version, EotFontValidator.ULONG_HEX_DIGITS)).join(
                ", ",
            )}`;

            throw BrokenEot.byRule(fontPath, {
                rule: EotRule.Version,
                at: at,
                field: "Version",
                value: this.hex(header.version, EotFontValidator.ULONG_HEX_DIGITS),
                expected: expected,
            });
        }

        header.reserved.forEach((reserved, index) => {
            if (reserved !== 0) {
                throw BrokenEot.byRule(fontPath, {
                    rule: EotRule.Reserved,
                    at: at,
                    field: `Reserved${index + 1}`,
                    value: this.hex(reserved, EotFontValidator.ULONG_HEX_DIGITS),
                    expected: "0",
                });
            }
        });
    }

    /**
     * The blocks of the header's version. The parse rejects a file that ends inside the Padding or
     * the size of a block, so that file breaks the rule on the blocks inside the file, and the
     * parse's answer stays as the cause.
     */
    private readBlocks(fontPath: string, header: EotHeader, fileSizeBytes: number): EotBlocks {
        try {
            const names = header.readNames();
            const tail = header.readTail();
            const blocks: Array<NamedBlock> = [
                { name: "FamilyName", paddingField: "Padding1", isText: true, block: names.familyName },
                { name: "StyleName", paddingField: "Padding2", isText: true, block: names.styleName },
                { name: "VersionName", paddingField: "Padding3", isText: true, block: names.versionName },
                { name: "FullName", paddingField: "Padding4", isText: true, block: names.fullName },
            ];

            if (names.rootString !== undefined) {
                blocks.push({ name: "RootString", paddingField: "Padding5", isText: true, block: names.rootString });
            }

            if (tail === undefined) {
                return { blocks: blocks, rootStringCheck: undefined, endOffset: names.endOffset };
            }

            blocks.push({ name: "Signature", paddingField: "Padding6", isText: false, block: tail.signature });

            return {
                blocks: blocks,
                // The tail exists only in version 0x00020002, which has RootString.
                rootStringCheck: { rootString: names.rootString as EotBlock, checkSum: tail.rootStringCheckSum },
                endOffset: tail.endOffset,
            };
        } catch (error) {
            if (!(error instanceof InvalidEot)) {
                throw error;
            }

            throw BrokenEot.byRuleAndCause(
                fontPath,
                {
                    rule: EotRule.BlocksInFile,
                    at: "the header",
                    field: "the file size",
                    value: fileSizeBytes,
                    expected: `room for the Padding and the size of every block of version ${this.hex(
                        header.version,
                        EotFontValidator.ULONG_HEX_DIGITS,
                    )}`,
                },
                error,
            );
        }
    }

    /**
     * The header ends inside the file, and FontData fills the rest of it. EOTSize is the file size
     * by now.
     */
    private checkLayout(fontPath: string, header: EotHeader, blocks: EotBlocks, fileSizeBytes: number): void {
        if (blocks.endOffset > fileSizeBytes) {
            throw BrokenEot.byRule(fontPath, {
                rule: EotRule.BlocksInFile,
                at: "the header",
                field: "end",
                value: blocks.endOffset,
                expected: `at most ${fileSizeBytes}, the file size`,
            });
        }

        if (header.fontDataSizeBytes === 0) {
            throw BrokenEot.byRule(fontPath, {
                rule: EotRule.FontDataLayout,
                at: "the header",
                field: "FontDataSize",
                value: header.fontDataSizeBytes,
                expected: "not 0",
            });
        }

        const fontDataEnd = blocks.endOffset + header.fontDataSizeBytes;

        if (fontDataEnd !== header.eotSizeBytes) {
            throw BrokenEot.byRule(fontPath, {
                rule: EotRule.FontDataLayout,
                at: "FontData",
                field: `the header end ${blocks.endOffset} + FontDataSize ${header.fontDataSizeBytes}`,
                value: fontDataEnd,
                expected: `${header.eotSizeBytes}, EOTSize`,
            });
        }
    }

    private checkBlocks(fontPath: string, { blocks }: EotBlocks): void {
        for (const { name, paddingField, isText, block } of blocks) {
            if (block.padding !== 0) {
                throw BrokenEot.byRule(fontPath, {
                    rule: EotRule.Padding,
                    at: `the block of ${name}`,
                    field: paddingField,
                    value: this.hex(block.padding, EotFontValidator.USHORT_HEX_DIGITS),
                    expected: "0x0000",
                });
            }

            if (isText && block.sizeBytes % EotFontValidator.UTF16_CHARACTER_SIZE_BYTES !== 0) {
                throw BrokenEot.byRule(fontPath, {
                    rule: EotRule.EvenSize,
                    at: `the block of ${name}`,
                    field: `${name}Size`,
                    value: block.sizeBytes,
                    expected: "an even number of bytes",
                });
            }
        }
    }

    /**
     * Only version 0x00020002 has the field, so only it is checked.
     */
    private checkRootStringCheckSum(fontPath: string, bytes: Uint8Array, rootStringCheck: RootStringCheck | undefined): void {
        if (rootStringCheck === undefined) {
            return;
        }

        const { rootString, checkSum } = rootStringCheck;
        const expected = (this.byteSum(bytes, rootString) ^ EotFontValidator.ROOT_STRING_CHECKSUM_KEY) >>> 0;

        if (checkSum !== expected) {
            throw BrokenEot.byRule(fontPath, {
                rule: EotRule.RootStringCheckSum,
                at: "the header",
                field: "RootStringCheckSum",
                value: this.hex(checkSum, EotFontValidator.ULONG_HEX_DIGITS),
                expected: this.hex(expected, EotFontValidator.ULONG_HEX_DIGITS),
            });
        }
    }

    private checkFlags(fontPath: string, header: EotHeader): void {
        if ((header.flags & EotFontValidator.UNSUPPORTED_FLAGS) !== 0) {
            throw BrokenEot.byRule(fontPath, {
                rule: EotRule.Flags,
                at: "the header",
                field: "Flags",
                value: this.hex(header.flags, EotFontValidator.ULONG_HEX_DIGITS),
                expected: `no bit of ${this.hex(EotFontValidator.UNSUPPORTED_FLAGS, EotFontValidator.ULONG_HEX_DIGITS)}`,
            });
        }
    }

    private checkFontData(fontPath: string, fontData: Uint8Array): void {
        try {
            SfntReader.validate(fontData);
        } catch (error) {
            if (!(error instanceof InvalidSfnt)) {
                throw error;
            }

            throw BrokenEot.byRuleAndCause(
                fontPath,
                {
                    rule: EotRule.FontData,
                    at: "FontData",
                    field: "the sfnt header",
                    value: JSON.stringify(error.message),
                    expected: "a header the codec reads",
                },
                error,
            );
        }
    }

    private byteSum(bytes: Uint8Array, block: EotBlock): number {
        let sum = 0;

        for (const byte of bytes.subarray(block.offset, block.offset + block.sizeBytes)) {
            sum += byte;
        }

        return sum;
    }

    private hex(value: number, digits: number): string {
        return `0x${value.toString(16).padStart(digits, "0")}`;
    }
}
