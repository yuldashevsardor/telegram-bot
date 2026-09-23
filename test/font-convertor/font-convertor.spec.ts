import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { FontConvertor } from "app/font-convertor/font-convertor";
import { ConvertorNotFound, FontConvertorError, InvalidFontSignature } from "app/font-convertor/font-convertor.errors";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import { InvalidPath, PermissionDenied } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const datedWoffPath = /^\d{4}\/\d{1,2}\/\d{1,2}\/[a-z0-9]{15}\.woff$/;

// The pairs are real, the engine is a stub: the choice of a pair and its input checks run here
// end to end, while what the engine does with the bytes is the subject of the pair specs.
// Permissions are taken away with chmod, so the spec is not for root (docs/architecture/testing.md).
describe("FontConvertor", function () {
    let tempDir: string;
    let lockedDirs: Array<string>;
    let engineCalls: Array<string>;
    let factory: ConvertorFactory;

    beforeEach(async function () {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "font-convertor-"));
        lockedDirs = [];
        engineCalls = [];

        const fontForge = {
            convert: async (fromPath: string, toPath: string) => {
                engineCalls.push(`${fromPath} -> ${toPath}`);
            },
        } as FontForge;

        factory = new ConvertorFactory(fontForge, new FontSignatureMatcher(), new EotPacker());
    });

    afterEach(async function () {
        // rm cannot walk a directory without the read permission, so permissions are restored first.
        for (const lockedDir of lockedDirs) {
            await fs.chmod(lockedDir, 0o700);
        }

        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("converts into a dated directory of the temp dir under a generated name", async function () {
        const result = await new FontConvertor(factory, tempDir).convert({ originPath: fixture(Extension.TTF), extension: Extension.WOFF });

        expect(path.relative(tempDir, result)).to.match(datedWoffPath);
        expect(engineCalls).to.deep.equal([`${fixture(Extension.TTF)} -> ${result}`]);
    });

    it("keeps the case of the temp dir", async function () {
        // The mkdtemp() suffix can be all lowercase, so the uppercase letters in the path are set explicitly.
        const directory = path.join(tempDir, "Upper-Case");
        await fs.mkdir(directory);

        const result = await new FontConvertor(factory, directory).convert({
            originPath: fixture(Extension.TTF),
            extension: Extension.WOFF,
        });

        expect(path.relative(directory, result)).to.match(datedWoffPath);
    });

    it("gives every conversion a new name", async function () {
        const fontConvertor = new FontConvertor(factory, tempDir);
        const params = { originPath: fixture(Extension.TTF), extension: Extension.WOFF };

        const first = await fontConvertor.convert(params);
        const second = await fontConvertor.convert(params);

        expect(second).to.not.equal(first);
    });

    for (const filename of ["font.ttf", "Font.TTF"]) {
        it(`rejects a target format equal to the source one named ${filename}`, async function () {
            const originPath = await copyTtfFixture(filename);

            const error = await rejectionOf(() =>
                new FontConvertor(factory, tempDir).convert({ originPath: originPath, extension: Extension.TTF }),
            );

            // The class is not enough: there is no ttf → ttf pair, and without a check of its own
            // the rejection would come from the factory, wrapped in the same FontConvertorError.
            expect(error).to.be.instanceOf(FontConvertorError);
            expect((error as FontConvertorError).message).to.equal("New and old font extension cannot be equal.");
            expect(engineCalls).to.be.empty;
        });
    }

    // The keys of the pair table are lowercase, and the case of the extension is set by whoever sent the file.
    for (const filename of ["Font.TTF", "Font.tTf"]) {
        it(`converts a source named ${filename} as a lowercase one`, async function () {
            const originPath = await copyTtfFixture(filename);

            const result = await new FontConvertor(factory, tempDir).convert({ originPath: originPath, extension: Extension.WOFF });

            expect(engineCalls).to.deep.equal([`${originPath} -> ${result}`]);
        });
    }

    // The source extension comes from the file name and is not checked against Extension: a
    // format absent from the pair table even as a source reaches ConvertorFactory.get() as is.
    // The rejection has to name the pair rather than fail with a TypeError reading the table.
    it("rejects a source in a format without pairs", async function () {
        const originPath = await copyTtfFixture("font.pfb");

        const error = await rejectionOf(() =>
            new FontConvertor(factory, tempDir).convert({ originPath: originPath, extension: Extension.WOFF }),
        );

        expect(error).to.be.instanceOf(FontConvertorError);
        expect((error as FontConvertorError).cause).to.be.instanceOf(ConvertorNotFound);
        expect(((error as FontConvertorError).cause as ConvertorNotFound).payload).to.deep.equal({ from: "pfb", to: Extension.WOFF });
        expect(engineCalls).to.be.empty;
    });

    it("wraps a failure of the pair", async function () {
        const originPath = path.join(tempDir, "garbage.ttf");
        await fs.writeFile(originPath, Uint8Array.from([1, 2, 3, 4]));

        const error = await rejectionOf(() =>
            new FontConvertor(factory, tempDir).convert({ originPath: originPath, extension: Extension.WOFF }),
        );

        expect(error).to.be.instanceOf(FontConvertorError);
        expect((error as FontConvertorError).cause).to.be.instanceOf(InvalidFontSignature);
    });

    // FileHelper.createDirectoriesByDate() checks the path, and its spec pins the checks
    // themselves. Here — that the rejection leaves convert() as is: the directory is created
    // before the try that wraps the pair's errors in FontConvertorError, and the engine is never
    // reached.
    describe("rejects the temp dir", function () {
        it("when it does not exist", async function () {
            const directory = path.join(tempDir, "missing");

            await expectRejection(directory, InvalidPath.isNotExist(directory));
        });

        it("when it cannot be read", async function () {
            const directory = await lockedDir(0o300);

            await expectRejection(directory, PermissionDenied.read(directory));
        });

        it("when it cannot be written", async function () {
            const directory = await lockedDir(0o500);

            await expectRejection(directory, PermissionDenied.write(directory));
        });

        it("when it is not a directory", async function () {
            const directory = path.join(tempDir, "file.bin");
            await fs.writeFile(directory, Uint8Array.from([0]));

            await expectRejection(directory, InvalidPath.isNotDirectory(directory));
        });
    });

    async function expectRejection(directory: string, expected: Error): Promise<void> {
        const error = await rejectionOf(() =>
            new FontConvertor(factory, directory).convert({ originPath: fixture(Extension.TTF), extension: Extension.WOFF }),
        );

        expect(error).to.be.instanceOf(expected.constructor);
        expect((error as Error).message).to.equal(expected.message);
        expect(engineCalls).to.be.empty;
    }

    async function lockedDir(mode: number): Promise<string> {
        const directory = path.join(tempDir, "locked");
        await fs.mkdir(directory);
        await fs.chmod(directory, mode);
        lockedDirs.push(directory);

        return directory;
    }

    function fixture(extension: Extension): string {
        return path.join(fixtureDir, `test-font.${extension}`);
    }

    async function copyTtfFixture(filename: string): Promise<string> {
        const copyPath = path.join(tempDir, filename);
        await fs.copyFile(fixture(Extension.TTF), copyPath);

        return copyPath;
    }

    function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
        return call().then(
            () => expect.fail("call did not throw"),
            (error: unknown) => error,
        );
    }
});

describe("ConvertorNotFound and InvalidFontSignature", function () {
    // The factories are checked directly: the spec above compares only the payload of
    // ConvertorNotFound, and the Convertor spec compares a rejection with an error from the same
    // factory, so the text there is compared with itself.
    const cases = [
        {
            name: "ConvertorNotFound.byExtensions",
            error: ConvertorNotFound.byExtensions(Extension.TTF, Extension.WOFF),
            type: ConvertorNotFound,
            message: "Convertor for ttf to woff not found.",
            payload: { from: "ttf", to: "woff" },
        },
        {
            name: "InvalidFontSignature.byPathAndExtension",
            error: InvalidFontSignature.byPathAndExtension("/x/font.ttf", Extension.TTF),
            type: InvalidFontSignature,
            message: "File /x/font.ttf content does not match ttf format.",
            payload: { path: "/x/font.ttf", extension: "ttf" },
        },
    ];

    for (const { name, error, type, message, payload } of cases) {
        it(`${name} keeps its message and details`, function () {
            expect(error).to.be.instanceOf(type);
            expect(error.message).to.equal(message);
            expect(error.payload).to.deep.equal(payload);
        });
    }
});
