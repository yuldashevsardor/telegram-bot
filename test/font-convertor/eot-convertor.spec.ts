import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/font-signature-matcher";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// Пары с EOT проверяются на подставных движке и кодеке: интересен порядок шагов и судьба
// промежуточного файла, а не то, что эти двое делают с байтами — на это у них свои спеки.
describe("Convertors of the eot pairs", function () {
    let workDir: string;
    let steps: Array<string>;
    let factory: ConvertorFactory;
    let failOn: string | undefined;

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eot-convertor-"));
        steps = [];
        failOn = undefined;
        factory = new ConvertorFactory(fontForge(), new FontSignatureMatcher(), eotPacker());
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    it("goes through the engine and then the packer on the way to eot", async function () {
        const result = await convert(Extension.WOFF, Extension.EOT);

        expect(steps).to.deep.equal([`fontForge ${source(Extension.WOFF)} -> ${result}.ttf`, `pack ${result}.ttf -> ${result}`]);
    });

    it("goes through the packer and then the engine on the way from eot", async function () {
        const result = await convert(Extension.EOT, Extension.WOFF);

        expect(steps).to.deep.equal([`unpack ${source(Extension.EOT)} -> ${result}.ttf`, `fontForge ${result}.ttf -> ${result}`]);
    });

    it("keeps the engine out of the ttf pairs entirely", async function () {
        const toEot = await convert(Extension.TTF, Extension.EOT);
        const fromEot = await convert(Extension.EOT, Extension.TTF);

        expect(steps).to.deep.equal([`pack ${source(Extension.TTF)} -> ${toEot}`, `unpack ${source(Extension.EOT)} -> ${fromEot}`]);
    });

    it("removes the intermediate font after a successful conversion", async function () {
        const result = await convert(Extension.SVG, Extension.EOT);

        expect(await exists(`${result}.ttf`), "промежуточный sfnt остался").to.be.false;
        expect(await exists(result)).to.be.true;
    });

    it("removes the intermediate font after a failed conversion too", async function () {
        failOn = "pack";

        await expectRejects(() => convert(Extension.OTF, Extension.EOT));

        expect(await exists(path.join(workDir, `result.${Extension.EOT}.ttf`))).to.be.false;
    });

    it("checks the source before touching the engine or the packer", async function () {
        // Расширение и сигнатура сверяются в Convertor.validate(): битый файл не должен
        // дойти ни до движка, ни до кодека.
        const brokenPath = path.join(workDir, `broken.${Extension.EOT}`);
        await fs.writeFile(brokenPath, Uint8Array.from([1, 2, 3, 4]));

        await expectRejects(() => factory.get(Extension.EOT, Extension.WOFF).convert(brokenPath, result(Extension.WOFF)));

        expect(steps).to.be.empty;
    });

    async function convert(from: Extension, to: Extension): Promise<string> {
        const newPath = result(to);

        await factory.get(from, to).convert(source(from), newPath);

        return newPath;
    }

    function source(extension: Extension): string {
        return path.join(fixtureDir, `test-font.${extension}`);
    }

    function result(extension: Extension): string {
        return path.join(workDir, `result.${extension}`);
    }

    // Подставные шаги пишут файл по своему пути: без него не проверить, что промежуточный
    // sfnt действительно убирают, а не просто не создают.
    async function step(name: string, fromPath: string, toPath: string): Promise<void> {
        steps.push(`${name} ${fromPath} -> ${toPath}`);

        if (failOn === name) {
            throw new Error(`${name} failed`);
        }

        await fs.writeFile(toPath, Uint8Array.from([0]));
    }

    function fontForge(): FontForge {
        return { convert: (fromPath: string, toPath: string) => step("fontForge", fromPath, toPath) } as FontForge;
    }

    function eotPacker(): EotPacker {
        return {
            pack: (fromPath: string, toPath: string) => step("pack", fromPath, toPath),
            unpack: (fromPath: string, toPath: string) => step("unpack", fromPath, toPath),
        } as EotPacker;
    }

    async function exists(filePath: string): Promise<boolean> {
        return await fs
            .access(filePath)
            .then(() => true)
            .catch(() => false);
    }

    async function expectRejects(call: () => Promise<unknown>): Promise<void> {
        try {
            await call();
            expect.fail("call did not throw");
        } catch (error) {
            expect(error).to.be.instanceOf(Error);
        }
    }
});
