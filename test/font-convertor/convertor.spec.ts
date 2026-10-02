import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Convertor } from "app/font-convertor/convertor/convertor";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import { WoffFontValidator } from "app/font-convertor/validator/woff/woff-font-validator";
import { EotFontValidator } from "app/font-convertor/validator/eot/eot-font-validator";
import { BrokenEot } from "app/font-convertor/validator/eot/eot-font-validator.errors";
import { EotRule } from "app/font-convertor/validator/eot/eot-font-validator.types";
import { NoFont } from "app/font-convertor/validator/svg/svg-font-validator.errors";
import { BrokenSfnt, NotSfnt } from "app/font-convertor/validator/sfnt/sfnt-font-validator.errors";
import { SfntRule } from "app/font-convertor/validator/sfnt/sfnt-font-validator.types";
import { BrokenWoff } from "app/font-convertor/validator/woff/woff-font-validator.errors";
import { WoffRule } from "app/font-convertor/validator/woff/woff-font-validator.types";
import { InvalidFile, InvalidPath, PermissionDenied } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
// The offset of numTables in the sfnt header (OpenType 1.9.1, Table Directory).
const SFNT_NUM_TABLES_OFFSET_BYTES = 4;
// The offset of the reserved field in the WOFF header (WOFF 1.0, §4).
const WOFF_RESERVED_OFFSET_BYTES = 14;
// The offset of Reserved1 in the EOT header (EOT, §3).
const EOT_RESERVED_1_OFFSET_BYTES = 64;

// Every pair shares the input check, Convertor.validate(), so its branches run on one pair,
// ttf → woff, the SVG branch on svg → woff, the WOFF one on woff → ttf and the EOT one on
// eot → woff. That each pair calls the check is pinned in font-forge-convertor.spec.ts and
// eot-convertor.spec.ts. The engine is a stub: a rejection has to happen before it. Permissions are
// taken away with chmod, so the spec is not for root (docs/architecture/testing.md).
describe("Convertor.validate", function () {
    let workDir: string;
    let lockedDirs: Array<string>;
    let engineCalls: Array<string>;
    let factory: ConvertorFactory;
    let convertor: Convertor;

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "convertor-"));
        lockedDirs = [];
        engineCalls = [];

        const fontForge = {
            convert: async (fromPath: string, toPath: string) => {
                engineCalls.push(`${fromPath} -> ${toPath}`);
            },
        } as FontForge;

        factory = new ConvertorFactory(
            fontForge,
            new FontValidatorResolver(
                new FontSignatureMatcher(),
                new SvgFontValidator(),
                new WoffFontValidator(new SfntFontValidator()),
                new SfntFontValidator(),
                new EotFontValidator(),
            ),
            new EotPacker(),
        );
        convertor = factory.get(Extension.TTF, Extension.WOFF);
    });

    afterEach(async function () {
        // rm cannot walk a directory without the read permission, so permissions are restored first.
        for (const lockedDir of lockedDirs) {
            await fs.chmod(lockedDir, 0o700);
        }

        await fs.rm(workDir, { recursive: true, force: true });
    });

    it("hands valid paths over to the engine", async function () {
        const toPath = inWorkDir("result.woff");

        await convertor.convert(fixture(Extension.TTF), toPath);

        expect(engineCalls).to.deep.equal([`${fixture(Extension.TTF)} -> ${toPath}`]);
    });

    it("takes either outline type under either sfnt extension", async function () {
        // The sfnt version names the outline type, not the extension: CFF under .ttf and TrueType
        // outlines under .otf are legal, and both extensions take the same validator.
        const cffPath = inWorkDir("cff.ttf");
        const trueTypePath = inWorkDir("true-type.otf");
        const toPath = inWorkDir("result.woff");
        await fs.copyFile(fixture(Extension.OTF), cffPath);
        await fs.copyFile(fixture(Extension.TTF), trueTypePath);

        await convertor.convert(cffPath, toPath);
        await factory.get(Extension.OTF, Extension.WOFF).convert(trueTypePath, toPath);

        expect(engineCalls).to.deep.equal([`${cffPath} -> ${toPath}`, `${trueTypePath} -> ${toPath}`]);
    });

    describe("rejects the source", function () {
        it("when it does not exist", async function () {
            const fromPath = inWorkDir("missing.ttf");

            await expectRejection(fromPath, inWorkDir("result.woff"), InvalidPath.isNotExist(fromPath));
        });

        it("when it cannot be read", async function () {
            const fromPath = inWorkDir("locked.ttf");
            await fs.copyFile(fixture(Extension.TTF), fromPath);
            await fs.chmod(fromPath, 0o000);

            await expectRejection(fromPath, inWorkDir("result.woff"), PermissionDenied.read(fromPath));
        });

        it("when it is not a file", async function () {
            const fromPath = inWorkDir("directory.ttf");
            await fs.mkdir(fromPath);

            await expectRejection(fromPath, inWorkDir("result.woff"), InvalidPath.isNotFile(fromPath));
        });

        it("when its extension belongs to another pair", async function () {
            const fromPath = fixture(Extension.OTF);

            await expectRejection(
                fromPath,
                inWorkDir("result.woff"),
                InvalidFile.byPathAndExtension(fromPath, Extension.OTF, Extension.TTF),
            );
        });

        it("when its content does not match the extension", async function () {
            const fromPath = inWorkDir("garbage.ttf");
            await fs.writeFile(fromPath, Uint8Array.from([1, 2, 3, 4]));

            await expectRejection(fromPath, inWorkDir("result.woff"), NotSfnt.bySize(fromPath, 4, 12));
        });

        it("when it is a ttf the validator rejects", async function () {
            // The version is intact, so a signature check alone would have let the file through.
            const fromPath = inWorkDir("no-tables.ttf");
            const bytes = await fs.readFile(fixture(Extension.TTF));
            bytes.writeUInt16BE(0, SFNT_NUM_TABLES_OFFSET_BYTES);
            await fs.writeFile(fromPath, bytes);

            await expectRejection(
                fromPath,
                inWorkDir("result.woff"),
                BrokenSfnt.byRule(fromPath, {
                    rule: SfntRule.TablesPresent,
                    at: "the header",
                    field: "numTables",
                    value: 0,
                    expected: "at least 1",
                }),
            );
        });

        it("when it is an svg the validator rejects", async function () {
            // SVG has no signature: the validator reads the whole document, and its error goes out as is.
            const fromPath = inWorkDir("no-font.svg");
            await fs.writeFile(fromPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
            convertor = factory.get(Extension.SVG, Extension.WOFF);

            await expectRejection(fromPath, inWorkDir("result.woff"), NoFont.inDocument(fromPath));
        });

        it("when it is a woff the validator rejects", async function () {
            // The signature is intact, so the signature check alone would have let the file through.
            const fromPath = inWorkDir("reserved.woff");
            const bytes = await fs.readFile(fixture(Extension.WOFF));
            bytes.writeUInt16BE(1, WOFF_RESERVED_OFFSET_BYTES);
            await fs.writeFile(fromPath, bytes);
            convertor = factory.get(Extension.WOFF, Extension.TTF);

            await expectRejection(
                fromPath,
                inWorkDir("result.ttf"),
                BrokenWoff.byRule(fromPath, { rule: WoffRule.Reserved, at: "the header", field: "reserved", value: 1, expected: "0" }),
            );
        });

        it("when it is an eot the validator rejects", async function () {
            // MagicNumber is intact, so the signature check alone would have let the file through.
            const fromPath = inWorkDir("reserved.eot");
            const bytes = await fs.readFile(fixture(Extension.EOT));
            bytes.writeUInt32LE(1, EOT_RESERVED_1_OFFSET_BYTES);
            await fs.writeFile(fromPath, bytes);
            convertor = factory.get(Extension.EOT, Extension.WOFF);

            await expectRejection(
                fromPath,
                inWorkDir("result.woff"),
                BrokenEot.byRule(fromPath, {
                    rule: EotRule.Reserved,
                    at: "the header",
                    field: "Reserved1",
                    value: "0x00000001",
                    expected: "0",
                }),
            );
        });
    });

    describe("rejects the result path", function () {
        it("when something is already there", async function () {
            const toPath = inWorkDir("result.woff");
            await fs.writeFile(toPath, Uint8Array.from([0]));

            await expectRejection(fixture(Extension.TTF), toPath, InvalidPath.isAlreadyExists(toPath));
        });

        it("when something is already there, even unreadable", async function () {
            // The ban on overwriting rests on FileHelper.isExist(): for it a file without the
            // read permission still exists.
            const toPath = inWorkDir("result.woff");
            await fs.writeFile(toPath, Uint8Array.from([0]));
            await fs.chmod(toPath, 0o000);

            await expectRejection(fixture(Extension.TTF), toPath, InvalidPath.isAlreadyExists(toPath));
        });

        it("when its directory does not exist", async function () {
            const directory = inWorkDir("missing");

            await expectRejection(fixture(Extension.TTF), path.join(directory, "result.woff"), InvalidPath.isNotExist(directory));
        });

        it("when its directory cannot be read", async function () {
            const directory = await lockedDir(0o300);

            await expectRejection(fixture(Extension.TTF), path.join(directory, "result.woff"), PermissionDenied.read(directory));
        });

        it("when its directory cannot be written", async function () {
            const directory = await lockedDir(0o500);

            await expectRejection(fixture(Extension.TTF), path.join(directory, "result.woff"), PermissionDenied.write(directory));
        });

        it("when its directory is not a directory", async function () {
            const directory = inWorkDir("file.bin");
            await fs.writeFile(directory, Uint8Array.from([0]));

            await expectRejection(fixture(Extension.TTF), path.join(directory, "result.woff"), InvalidPath.isNotDirectory(directory));
        });

        it("when its extension belongs to another pair", async function () {
            const toPath = inWorkDir("result.otf");

            await expectRejection(fixture(Extension.TTF), toPath, InvalidFile.byPathAndExtension(toPath, Extension.OTF, Extension.WOFF));
        });
    });

    async function expectRejection(fromPath: string, toPath: string, expected: Error): Promise<void> {
        const error = await rejectionOf(() => convertor.convert(fromPath, toPath));

        expect(error).to.be.instanceOf(expected.constructor);
        expect((error as Error).message).to.equal(expected.message);
        expect(engineCalls, "a rejected input reached the engine").to.be.empty;
    }

    async function lockedDir(mode: number): Promise<string> {
        const directory = inWorkDir("locked");
        await fs.mkdir(directory);
        await fs.chmod(directory, mode);
        lockedDirs.push(directory);

        return directory;
    }

    function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
        return call().then(
            () => expect.fail("call did not throw"),
            (error: unknown) => error,
        );
    }

    function inWorkDir(name: string): string {
        return path.join(workDir, name);
    }

    function fixture(extension: Extension): string {
        return path.join(fixtureDir, `test-font.${extension}`);
    }
});
