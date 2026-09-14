import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { FontConvertor } from "app/font-convertor/font-convertor";
import { FontConvertorError, InvalidFontSignature } from "app/font-convertor/font-convertor.errors";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/font-signature-matcher";
import { InvalidPath, PermissionDenied } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const datedWoffPath = /^\d{4}\/\d{1,2}\/\d{1,2}\/[a-z0-9]{15}\.woff$/;

// Пары настоящие, движок подставной: выбор пары и её проверки входа здесь идут насквозь, а
// что движок делает с байтами — предмет спеки пар. Права отнимаются chmod, поэтому спека не
// для root (docs/architecture/testing.md).
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
        // Каталог без права чтения rm не обойдёт, поэтому права возвращаются до уборки.
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
        // Суффикс mkdtemp() бывает и строчным, поэтому заглавные в пути задаются явно.
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

    it("rejects a target format equal to the source one", async function () {
        const error = await rejectionOf(() =>
            new FontConvertor(factory, tempDir).convert({ originPath: fixture(Extension.TTF), extension: Extension.TTF }),
        );

        // Класса мало: пары ttf → ttf нет, и без своей проверки отказ пришёл бы от фабрики,
        // обёрнутый в тот же FontConvertorError.
        expect(error).to.be.instanceOf(FontConvertorError);
        expect((error as FontConvertorError).message).to.equal("New and old font extension cannot be equal.");
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

    // Те же четыре отказа с теми же ошибками бросает и FileHelper.createDirectoriesByDate(),
    // которую convert() зовёт после prepare(): эти тесты не отличают, чья проверка сработала.
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

    function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
        return call().then(
            () => expect.fail("call did not throw"),
            (error: unknown) => error,
        );
    }
});
