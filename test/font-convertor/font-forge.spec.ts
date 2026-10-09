import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { ExecuteError, ExtensionNotSupport } from "app/font-convertor/font-forge/font-forge.errors";
import { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import { WoffFontValidator } from "app/font-convertor/validator/woff/woff-font-validator";
import { Woff2FontValidator } from "app/font-convertor/validator/woff2/woff2-font-validator";
import { EotFontValidator } from "app/font-convertor/validator/eot/eot-font-validator";
import { FileHelper } from "app/shared/fs/file-helper";
import { ProcessFailed } from "app/shared/process/process-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

describe("FontForge.convert", function () {
    const fontForge = new FontForge("fontforge");
    const engineExtensions = new ConvertorFactory(
        fontForge,
        new FontValidatorResolver(
            new SvgFontValidator(),
            new WoffFontValidator(new SfntFontValidator()),
            new Woff2FontValidator(new SfntFontValidator()),
            new SfntFontValidator(),
            new EotFontValidator(new SfntFontValidator(), new EotPayloadDecoder()),
        ),
        new EotPacker(new EotPayloadDecoder()),
    )
        .getSupportedExtensions()
        .filter((extension) => extension !== Extension.EOT);
    let workDir: string;

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "font-forge-"));
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    // The pair has different formats on purpose: TTF and OTF share one validator, and with it the
    // test would pass even if the engine just copied the source.
    it("converts a font with the engine", async function () {
        const distPath = path.join(workDir, "result.woff");

        await fontForge.convert(fixture(Extension.TTF), distPath);

        await new WoffFontValidator(new SfntFontValidator()).validate(distPath);
    });

    // The case of the source extension is set by whoever sent the file, and the engine's format list is lowercase.
    for (const extension of engineExtensions) {
        it(`reads ${extension} under an uppercase extension`, async function () {
            const srcPath = path.join(workDir, `Font.${extension.toUpperCase()}`);
            const distPath = path.join(workDir, "result.otf");
            await fs.copyFile(fixture(extension), srcPath);

            await fontForge.convert(srcPath, distPath);

            await new SfntFontValidator().validate(distPath);
        });
    }

    // Without the copy fontforge writes I_I.salt_v under the code points of its ligature alone, and U+E202
    // is not in the font at all.
    it("writes into svg a glyph with a ligature under its own code point as well", async function () {
        const distPath = path.join(workDir, "result.svg");

        await fontForge.convert(path.join(fixtureDir, "bungee-spice", "BungeeSpice-Regular.ttf"), distPath);

        const svgFont = await fs.readFile(distPath, "utf8");
        expect(svgFont).to.include('<glyph glyph-name="I_I.salt_v" unicode="&#xe201;&#xe201;" vert-adv-y="854"');
        expect(svgFont).to.include('<glyph glyph-name="I_I.salt_v.uE202" unicode="&#xe202;" vert-adv-y="854"');
    });

    // The glyph uni06D5 has U+06D5 and the presentation form U+FEE9, which fontforge writes as U+0647 with
    // arabic-form. uniFBE8 has the presentation form alone, so it needs no copy.
    it("writes into svg each code point of a glyph with an arabic presentation form", async function () {
        const distPath = path.join(workDir, "result.svg");

        await fontForge.convert(path.join(fixtureDir, "noto-naskh-arabic", "NotoNaskhArabic-Regular.ttf"), distPath);

        const svgFont = await fs.readFile(distPath, "utf8");
        expect(svgFont).to.include('<glyph glyph-name="uni06D5" unicode="&#x647;" horiz-adv-x="408" arabic-form="isolated"');
        expect(svgFont).to.include('<glyph glyph-name="uni06D5.u06D5" unicode="&#x6d5;" horiz-adv-x="408"');
        expect(svgFont).not.to.include('glyph-name="uniFBE8.');
    });

    // The CFF of an OTF keeps the glyph names as text, so a copy would show by its name.
    it("adds no glyph copies to a font of another format", async function () {
        const distPath = path.join(workDir, "result.otf");

        await fontForge.convert(path.join(fixtureDir, "bungee-spice", "BungeeSpice-Regular.ttf"), distPath);

        const otfFont = await fs.readFile(distPath);
        expect(otfFont.includes("I_I.salt_v")).to.be.true;
        expect(otfFont.includes("I_I.salt_v.uE202")).to.be.false;
    });

    it("does not give eot to the engine to read", async function () {
        const error = await rejectionOf(() => fontForge.convert(fixture(Extension.EOT), path.join(workDir, "result.ttf")));

        expect(error).to.be.instanceOf(ExtensionNotSupport);
        expect((error as ExtensionNotSupport).payload).to.deep.equal({ extension: Extension.EOT });
        // The payload does not replace the message. FontConvertorError.byError() takes the message
        // as its own, and the conversion failure goes to the log with it.
        expect((error as ExtensionNotSupport).message).to.equal("Fontforge not support eot extension.");
    });

    it("does not give eot to the engine to write", async function () {
        // The check has to fire before the launch, and no file may appear at all. On writing the
        // engine does not fail but silently puts another format under .eot.
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
