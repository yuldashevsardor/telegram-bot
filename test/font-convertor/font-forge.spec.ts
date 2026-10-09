import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { SaxesParser } from "saxes";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { ExecuteError, ExtensionNotSupport } from "app/font-convertor/font-forge/font-forge.errors";
import { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import { SvgTextCodec } from "app/font-convertor/validator/svg/svg-text-codec";
import { SvgFontPreparer } from "app/font-convertor/svg-preparer/svg-font-preparer";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import { WoffFontValidator } from "app/font-convertor/validator/woff/woff-font-validator";
import { Woff2FontValidator } from "app/font-convertor/validator/woff2/woff2-font-validator";
import { EotFontValidator } from "app/font-convertor/validator/eot/eot-font-validator";
import { FileHelper } from "app/shared/fs/file-helper";
import { ProcessHelper } from "app/shared/process/process-helper";
import { ProcessFailed } from "app/shared/process/process-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const bungeeSpicePath = path.join(fixtureDir, "bungee-spice", "BungeeSpice-Regular.ttf");

describe("FontForge.convert", function () {
    const fontForge = new FontForge(new SvgFontPreparer(new SvgTextCodec()), "fontforge");
    const engineExtensions = new ConvertorFactory(
        fontForge,
        new FontValidatorResolver(
            new SvgFontValidator(new SvgTextCodec()),
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

        await fontForge.convert(bungeeSpicePath, distPath);

        const glyphs = await glyphsByName(distPath);
        expect(glyphs.get("I_I.salt_v")).to.include({ unicode: "\u{E201}\u{E201}" });
        expect(glyphs.get("I_I.salt_v.uE202")).to.include({ unicode: "\u{E202}", "vert-adv-y": "854" });
    });

    it("writes into svg a copy whose name is taken without touching the glyph that has it", async function () {
        const srcPath = path.join(workDir, "taken-name.ttf");
        const distPath = path.join(workDir, "result.svg");
        const renameScript =
            'import fontforge, sys; font = fontforge.open(sys.argv[1]); font["A"].glyphname = "I_I.salt_v.uE202"; font.generate(sys.argv[2])';
        await ProcessHelper.run("fontforge", ["-c", renameScript, bungeeSpicePath, srcPath]);

        await fontForge.convert(srcPath, distPath);

        const glyphs = await glyphsByName(distPath);
        expect(glyphs.get("I_I.salt_v.uE202")).to.include({ unicode: "A" });
        expect([...glyphs.values()].map((glyph) => glyph["unicode"])).to.include("\u{E202}");
    });

    // The glyph uni06D5 has U+06D5 and the presentation form U+FEE9, which fontforge writes as U+0647 with
    // arabic-form. uniFBE8 has the presentation form alone, so it needs no copy.
    it("writes into svg each code point of a glyph with an arabic presentation form", async function () {
        const distPath = path.join(workDir, "result.svg");

        await fontForge.convert(path.join(fixtureDir, "noto-naskh-arabic", "NotoNaskhArabic-Regular.ttf"), distPath);

        const glyphs = await glyphsByName(distPath);
        expect(glyphs.get("uni06D5")).to.include({ unicode: "\u0647", "arabic-form": "isolated" });
        expect(glyphs.get("uni06D5.u06D5")).to.include({ unicode: "\u06D5", "horiz-adv-x": "408" });
        expect([...glyphs.keys()].filter((glyphName) => glyphName.startsWith("uniFBE8."))).to.be.empty;
    });

    // The CFF of an OTF keeps the glyph names as text, so a copy would show by its name.
    it("adds no glyph copies to a font of another format", async function () {
        const distPath = path.join(workDir, "result.otf");

        await fontForge.convert(bungeeSpicePath, distPath);

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

    // fontforge gives a glyph that leaves horiz-adv-x out the em when <font> says 0, and drops it when
    // it has no outline either (issue #913). It reads a prepared copy instead.
    it("reads an SVG glyph that leaves its advance to <font> as SVG 1.1 does", async function () {
        const srcPath = path.join(workDir, "font.svg");
        const distPath = path.join(workDir, "result.ttf");
        await fs.writeFile(
            srcPath,
            '<svg xmlns="http://www.w3.org/2000/svg"><font horiz-adv-x="0"><font-face units-per-em="1000" ascent="800" descent="-200"/>' +
                '<glyph unicode="a" horiz-adv-x="500" d="M0 0h400v700h-400z"/><glyph unicode="&#x300;" d="M0 600h100v100h-100z"/>' +
                '<glyph unicode="&#x200B;"/></font></svg>',
        );

        await fontForge.convert(srcPath, distPath);

        // The result is a TTF, which fontforge reads right; a code point without a glyph prints null.
        const widthsScript = [
            "import fontforge, json, sys",
            "widths = {glyph.unicode: glyph.width for glyph in fontforge.open(sys.argv[1]).glyphs()}",
            "print(json.dumps([widths.get(0x0300), widths.get(0x200b)]))",
        ].join("\n");
        const { stdout } = await ProcessHelper.run("fontforge", ["-c", widthsScript, distPath]);
        expect(JSON.parse(stdout)).to.deep.equal([0, 0]);
    });

    // fontforge reads a glyph with arabic-form under the presentation form its table gives, and for the
    // initial and medial forms of U+0649 under the letter itself (issue #924). It reads a prepared copy
    // instead.
    it("reads an SVG glyph with an arabic form under the letter SVG 1.1 gives it", async function () {
        const srcPath = path.join(workDir, "font.svg");
        const distPath = path.join(workDir, "result.ttf");
        await fs.writeFile(
            srcPath,
            '<svg xmlns="http://www.w3.org/2000/svg"><font horiz-adv-x="0"><font-face units-per-em="1000" ascent="800" descent="-200"/>' +
                '<glyph unicode="&#x627;" arabic-form="isolated" horiz-adv-x="100"/><glyph unicode="&#x627;" arabic-form="final" horiz-adv-x="110"/>' +
                '<glyph unicode="&#x628;" arabic-form="isolated" horiz-adv-x="200"/><glyph unicode="&#x628;" horiz-adv-x="210"/>' +
                '<glyph unicode="&#x649;" arabic-form="initial" horiz-adv-x="300"/><glyph unicode="&#x649;" arabic-form="medial" horiz-adv-x="310"/>' +
                '<glyph unicode="&#x649;" horiz-adv-x="320"/></font></svg>',
        );

        await fontForge.convert(srcPath, distPath);

        // The result is a TTF, which fontforge reads right: the width of each encoded glyph by its code point.
        const widthsScript = [
            "import fontforge, json, sys",
            "widths = {glyph.unicode: glyph.width for glyph in fontforge.open(sys.argv[1]).glyphs() if glyph.unicode != -1}",
            "print(json.dumps(sorted(widths.items())))",
        ].join("\n");
        const { stdout } = await ProcessHelper.run("fontforge", ["-c", widthsScript, distPath]);
        expect(JSON.parse(stdout)).to.deep.equal([
            [0x0627, 100],
            [0x0628, 210],
            [0x0649, 320],
            [0xfbe8, 300],
            [0xfbe9, 310],
            [0xfe8e, 110],
            [0xfe8f, 200],
        ]);
    });

    it("removes the prepared copy of an SVG source after a success and after a failure", async function () {
        const srcPath = path.join(workDir, "font.svg");
        await fs.copyFile(fixture(Extension.SVG), srcPath);

        await fontForge.convert(srcPath, path.join(workDir, "result.ttf"));

        // fontforge does not open a font without units-per-em: the copy is prepared, the engine fails.
        const brokenPath = path.join(workDir, "broken.svg");
        await fs.writeFile(brokenPath, '<svg xmlns="http://www.w3.org/2000/svg"><font horiz-adv-x="0"><font-face/><glyph/></font></svg>');

        const error = await rejectionOf(() => fontForge.convert(brokenPath, path.join(workDir, "broken.otf")));

        expect(error).to.be.instanceOf(ExecuteError);
        // The engine read the copy, gone by now: the error names the source the conversion was given.
        expect((error as ExecuteError).payload).to.deep.equal({ path: brokenPath });
        expect((await fs.readdir(workDir)).sort()).to.deep.equal(["broken.svg", "font.svg", "result.ttf"]);
    });

    it("wraps a failure of the engine", async function () {
        const srcPath = path.join(workDir, "garbage.ttf");
        await fs.writeFile(srcPath, Uint8Array.from([1, 2, 3, 4]));

        const error = await rejectionOf(() => fontForge.convert(srcPath, path.join(workDir, "result.otf")));

        expect(error).to.be.instanceOf(ExecuteError);
        expect((error as ExecuteError).cause).to.be.instanceOf(ProcessFailed);
        expect((error as ExecuteError).payload).to.deep.equal({ path: srcPath });
    });

    it("names the source it is given in place of the file it reads", async function () {
        const srcPath = path.join(workDir, "garbage.ttf");
        const eotPath = path.join(workDir, "font.eot");
        await fs.writeFile(srcPath, Uint8Array.from([1, 2, 3, 4]));

        const error = await rejectionOf(() => fontForge.convert(srcPath, path.join(workDir, "result.otf"), eotPath));

        expect((error as ExecuteError).payload).to.deep.equal({ path: eotPath });
    });

    // The attributes of each <glyph> element by its name, read by an XML parser: the specs check the
    // element under a code point, not the order or the escaping fontforge writes it with.
    async function glyphsByName(svgPath: string): Promise<Map<string, Record<string, string>>> {
        const glyphs = new Map<string, Record<string, string>>();
        const parser = new SaxesParser();
        parser.on("opentag", (tag) => {
            const glyphName = tag.attributes["glyph-name"];
            if (tag.name === "glyph" && glyphName !== undefined) {
                glyphs.set(glyphName, tag.attributes);
            }
        });
        parser.write(await fs.readFile(svgPath, "utf8")).close();

        return glyphs;
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
