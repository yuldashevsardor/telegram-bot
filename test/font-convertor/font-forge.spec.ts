import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { ExecuteError, ExtensionNotSupport } from "app/font-convertor/font-forge/font-forge.errors";
import { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import { FileHelper } from "app/shared/fs/file-helper";
import { ProcessFailed } from "app/shared/process/process-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

describe("FontForge.convert", function () {
    const fontForge = new FontForge("fontforge");
    const engineExtensions = new ConvertorFactory(fontForge, new FontSignatureMatcher(), new EotPacker())
        .getSupportedExtensions()
        .filter((extension) => extension !== Extension.EOT);
    let workDir: string;

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "font-forge-"));
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    // Сигнатуры у пары разные намеренно: у TTF и OTF она общая, и с ней тест прошёл бы, даже
    // если бы движок просто скопировал исходник.
    it("converts a font with the engine", async function () {
        const matcher = new FontSignatureMatcher();
        const distPath = path.join(workDir, "result.woff");

        await fontForge.convert(fixture(Extension.TTF), distPath);

        expect(matcher.matches(await FileHelper.readHead(distPath, matcher.headLength), Extension.WOFF)).to.be.true;
    });

    // Регистр расширения исходника задаёт тот, кто прислал файл, а список форматов движка строчный.
    for (const extension of engineExtensions) {
        it(`reads ${extension} under an uppercase extension`, async function () {
            const matcher = new FontSignatureMatcher();
            const srcPath = path.join(workDir, `Font.${extension.toUpperCase()}`);
            const distPath = path.join(workDir, "result.otf");
            await fs.copyFile(fixture(extension), srcPath);

            await fontForge.convert(srcPath, distPath);

            expect(matcher.matches(await FileHelper.readHead(distPath, matcher.headLength), Extension.OTF)).to.be.true;
        });
    }

    it("does not give eot to the engine to read", async function () {
        const error = await rejectionOf(() => fontForge.convert(fixture(Extension.EOT), path.join(workDir, "result.ttf")));

        expect(error).to.be.instanceOf(ExtensionNotSupport);
        expect((error as ExtensionNotSupport).payload).to.deep.equal({ extension: Extension.EOT });
        // Сообщение payload не заменяет: FontConvertorError.byError() берёт своим именно его, и в
        // лог отказ конвертации уходит с ним.
        expect((error as ExtensionNotSupport).message).to.equal("Fontforge not support eot extension.");
    });

    it("does not give eot to the engine to write", async function () {
        // На запись движок не падает, а молча кладёт под .eot чужой формат: проверка обязана
        // сработать до запуска, и файла не должно появиться вовсе.
        const distPath = path.join(workDir, "result.eot");

        const error = await rejectionOf(() => fontForge.convert(fixture(Extension.TTF), distPath));

        expect(error).to.be.instanceOf(ExtensionNotSupport);
        expect((error as ExtensionNotSupport).payload).to.deep.equal({ extension: Extension.EOT });
        expect(await FileHelper.isExist(distPath)).to.be.false;
    });

    it("wraps a failure of the engine", async function () {
        const srcPath = path.join(workDir, "garbage.ttf");
        await fs.writeFile(srcPath, Uint8Array.from([1, 2, 3, 4]));

        const error = await rejectionOf(() => fontForge.convert(srcPath, path.join(workDir, "result.otf")));

        expect(error).to.be.instanceOf(ExecuteError);
        expect((error as ExecuteError).cause).to.be.instanceOf(ProcessFailed);
    });

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
