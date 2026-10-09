import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Extension } from "app/font-convertor/font-convertor.types";
import { SvgFontPreparer } from "app/font-convertor/svg-preparer/svg-font-preparer";
import { UnpreparableSvgFont } from "app/font-convertor/svg-preparer/svg-font-preparer.errors";
import { SvgTextCodec } from "app/font-convertor/validator/svg/svg-text-codec";
import { ReadFailed } from "app/shared/fs/file-helper.errors";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const FONT_FACE = '<font-face units-per-em="1000"/>';

// A document around the content of a font whose advance is `fontAdvance`.
function fontDocument(fontAdvance: string, glyphs: string): string {
    return `<svg xmlns="${SVG_NAMESPACE}"><font horiz-adv-x="${fontAdvance}">${FONT_FACE}${glyphs}</font></svg>`;
}

describe("SvgFontPreparer.prepare", function () {
    const textCodec = new SvgTextCodec();
    const preparer = new SvgFontPreparer(textCodec);
    let workDir: string;
    let sourcePath: string;
    let preparedPath: string;

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "svg-font-preparer-"));
        sourcePath = path.join(workDir, `source.${Extension.SVG}`);
        preparedPath = path.join(workDir, `prepared.${Extension.SVG}`);
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    it("writes the advance of <font> on a glyph that leaves it out", async function () {
        expect(await prepared(fontDocument("0", '<glyph unicode="&#x300;" d="M0 0h10v10z"/>'))).to.equal(
            fontDocument("0", '<glyph unicode="&#x300;" d="M0 0h10v10z" horiz-adv-x="0"/>'),
        );
    });

    it("writes the advance of <font> on an empty glyph and on <missing-glyph>", async function () {
        expect(await prepared(fontDocument("1000", '<missing-glyph/><glyph unicode="&#x2003;"></glyph>'))).to.equal(
            fontDocument("1000", '<missing-glyph horiz-adv-x="1000"/><glyph unicode="&#x2003;" horiz-adv-x="1000"></glyph>'),
        );
    });

    it("keeps the advance of a glyph that has one", async function () {
        const source = fontDocument("0", '<glyph unicode="a" horiz-adv-x="500"/>');

        expect(await prepared(source)).to.equal(source);
    });

    it("copies the advance of <font> as it is written", async function () {
        // fontforge truncates a fraction of an advance as it reads it, wherever it is written.
        expect(await prepared(fontDocument("512.5", '<glyph unicode="a"/>'))).to.equal(
            fontDocument("512.5", '<glyph unicode="a" horiz-adv-x="512.5"/>'),
        );
    });

    it("writes the attribute before the end of the start tag, wherever the tag breaks", async function () {
        // A character outside the BMP is two UTF-16 units: the position of the parser counts units, as
        // the indexes of a string do.
        const glyphs = '<glyph unicode="\u{1F600}"\r\n   />\n<glyph\tunicode="b" >\n</glyph>';

        expect(await prepared(fontDocument("0", glyphs))).to.equal(
            fontDocument("0", '<glyph unicode="\u{1F600}"\r\n    horiz-adv-x="0"/>\n<glyph\tunicode="b"  horiz-adv-x="0">\n</glyph>'),
        );
    });

    it("leaves a glyph that is not a child of <font> alone", async function () {
        // SVG 1.1 counts the font nodes only as the direct children of <font> (§20.3).
        const source = `<svg xmlns="${SVG_NAMESPACE}"><glyph/><font horiz-adv-x="0">${FONT_FACE}<g><glyph/></g><glyph horiz-adv-x="1"/></font></svg>`;

        expect(await prepared(source)).to.equal(source);
    });

    it("matches the font nodes by their local names", async function () {
        const source = `<s:svg xmlns:s="${SVG_NAMESPACE}"><s:font horiz-adv-x="0"><s:font-face units-per-em="1000"/><s:glyph/></s:font></s:svg>`;

        expect(await prepared(source)).to.equal(source.replace("<s:glyph/>", '<s:glyph horiz-adv-x="0"/>'));
    });

    it("keeps the rest of the file byte for byte", async function () {
        const source = `<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n<!-- <glyph/> -->${fontDocument(
            "0",
            '<glyph unicode="&amp;"/><![CDATA[<glyph/>]]>',
        )}`;

        expect(await prepared(source)).to.equal(source.replace('<glyph unicode="&amp;"/>', '<glyph unicode="&amp;" horiz-adv-x="0"/>'));
    });

    it("writes the copy in the encoding of the source", async function () {
        const source = fontDocument("0", "<glyph/>");
        const expected = fontDocument("0", '<glyph horiz-adv-x="0"/>');

        for (const encoding of ["utf-16le", "utf-16be"] as const) {
            await fs.rm(preparedPath, { force: true });
            await fs.writeFile(sourcePath, textCodec.encode(source, encoding));
            await preparer.prepare(sourcePath, preparedPath);

            expect(Buffer.from(await fs.readFile(preparedPath)).equals(textCodec.encode(expected, encoding)), encoding).to.be.true;
        }
    });

    it("gives the copy the modification time of the source", async function () {
        // fontforge stamps the font it writes with the modification time of the file it reads.
        await fs.writeFile(sourcePath, fontDocument("0", "<glyph/>"));
        await fs.utimes(sourcePath, 1_500_000_000, 1_600_000_000);

        await preparer.prepare(sourcePath, preparedPath);

        expect((await fs.stat(preparedPath)).mtimeMs).to.equal(1_600_000_000_000);
    });

    it("leaves the source as it is", async function () {
        const source = fontDocument("0", "<glyph/>");

        await prepared(source);

        expect(await fs.readFile(sourcePath, "utf8")).to.equal(source);
    });

    it("answers a source that is not XML without quoting it", async function () {
        await fs.writeFile(sourcePath, "<svg><secret-name></svg>");

        const error = await rejectionOf(() => preparer.prepare(sourcePath, preparedPath));

        expect(error).to.be.instanceOf(UnpreparableSvgFont);
        expect((error as UnpreparableSvgFont).message).to.not.include("secret-name");
        expect((error as UnpreparableSvgFont).payload).to.deep.equal({ path: sourcePath });
    });

    it("answers a source whose bytes are not in its encoding", async function () {
        await fs.writeFile(sourcePath, Uint8Array.from([0x3c, 0xff, 0x3e]));

        const error = await rejectionOf(() => preparer.prepare(sourcePath, preparedPath));

        expect(error).to.be.instanceOf(UnpreparableSvgFont);
        expect((error as UnpreparableSvgFont).cause).to.be.instanceOf(TypeError);
    });

    it("lets the read failure of a missing source through", async function () {
        expect(await rejectionOf(() => preparer.prepare(path.join(workDir, "missing.svg"), preparedPath))).to.be.instanceOf(ReadFailed);
    });

    async function prepared(source: string): Promise<string> {
        await fs.writeFile(sourcePath, source);
        await preparer.prepare(sourcePath, preparedPath);

        return fs.readFile(preparedPath, "utf8");
    }

    function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
        return call().then(
            () => expect.fail("call did not throw"),
            (error: unknown) => error,
        );
    }
});
