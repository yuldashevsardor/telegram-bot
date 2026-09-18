import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Convertor } from "app/font-convertor/convertor/convertor";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { InvalidFontSignature } from "app/font-convertor/font-convertor.errors";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import { InvalidFile, InvalidPath, PermissionDenied } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// Проверка входа у всех пар общая (Convertor.validate()), поэтому её ветви гоняются на одной
// паре ttf → woff; что проверку вызывает каждая пара, закреплено в font-forge-convertor.spec.ts
// и eot-convertor.spec.ts. Движок подставной: отказ обязан случиться раньше него. Права
// отнимаются chmod, поэтому спека не для root (docs/architecture/testing.md).
describe("Convertor.validate", function () {
    let workDir: string;
    let lockedDirs: Array<string>;
    let engineCalls: Array<string>;
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

        convertor = new ConvertorFactory(fontForge, new FontSignatureMatcher(), new EotPacker()).get(Extension.TTF, Extension.WOFF);
    });

    afterEach(async function () {
        // Каталог без права чтения rm не обойдёт, поэтому права возвращаются до уборки.
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

            await expectRejection(fromPath, inWorkDir("result.woff"), InvalidFontSignature.byPathAndExtension(fromPath, Extension.TTF));
        });
    });

    describe("rejects the result path", function () {
        it("when something is already there", async function () {
            const toPath = inWorkDir("result.woff");
            await fs.writeFile(toPath, Uint8Array.from([0]));

            await expectRejection(fixture(Extension.TTF), toPath, InvalidPath.isAlreadyExists(toPath));
        });

        it("when something is already there, even unreadable", async function () {
            // Запрет перезаписи держится на FileHelper.isExist(): файл без права чтения для
            // него всё равно существует.
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
        expect(engineCalls, "отвергнутый вход дошёл до движка").to.be.empty;
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
