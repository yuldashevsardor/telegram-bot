import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { ExecuteError, ExtensionNotSupport } from "app/font-convertor/font-forge/font-forge.errors";
import { FontSignatureMatcher } from "app/font-convertor/font-signature-matcher";
import { FileHelper } from "app/shared/fs/file-helper";
import { ProcessFailed } from "app/shared/process/process-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

describe("FontForge.convert", function () {
    const fontForge = new FontForge("fontforge");
    let workDir: string;

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "font-forge-"));
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    it("converts a font with the engine", async function () {
        const matcher = new FontSignatureMatcher();
        const distPath = path.join(workDir, "result.otf");

        await fontForge.convert(fixture(Extension.TTF), distPath);

        expect(matcher.matches(await FileHelper.readHead(distPath, matcher.headLength), Extension.OTF)).to.be.true;
    });

    // Регистр расширения исходника задаёт тот, кто прислал файл, а список форматов движка строчный.
    for (const extension of [Extension.OTF, Extension.SVG, Extension.TTF, Extension.WOFF, Extension.WOFF2]) {
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
