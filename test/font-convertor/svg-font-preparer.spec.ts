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

    it("takes the isolated form off a glyph whose letter has no glyph without a form", async function () {
        const glyphs = '<glyph unicode="&#x627;" arabic-form="isolated"/><glyph unicode="&#x627;" arabic-form="final"/>';

        expect(await prepared(fontDocument("0", glyphs))).to.equal(
            fontDocument("0", '<glyph unicode="&#x627;" horiz-adv-x="0"/><glyph unicode="&#x627;" arabic-form="final" horiz-adv-x="0"/>'),
        );
    });

    it("keeps the isolated form of a letter that has a glyph without a form, wherever that glyph stands", async function () {
        const glyphs = '<glyph unicode="&#x628;" arabic-form="isolated" horiz-adv-x="1"/><glyph unicode="&#x628;" horiz-adv-x="1"/>';

        expect(await prepared(fontDocument("0", glyphs))).to.equal(fontDocument("0", glyphs));
    });

    it("takes the isolated form off when only <missing-glyph> names the letter", async function () {
        // fontforge reads <missing-glyph> as .notdef, whatever its unicode says.
        const glyphs =
            '<missing-glyph unicode="&#x627;" horiz-adv-x="1"/><glyph unicode="&#x627;" arabic-form="isolated" horiz-adv-x="1"/>';

        expect(await prepared(fontDocument("0", glyphs))).to.equal(fontDocument("0", glyphs.replace(' arabic-form="isolated"', "")));
    });

    it("writes the terminal form of SVG 1.1 as the final form fontforge knows", async function () {
        const glyphs =
            '<glyph unicode="&#x627;" arabic-form="isolated" horiz-adv-x="1"/><glyph unicode="&#x627;" arabic-form="terminal" horiz-adv-x="1"/>';

        expect(await prepared(fontDocument("0", glyphs))).to.equal(
            fontDocument("0", '<glyph unicode="&#x627;" horiz-adv-x="1"/><glyph unicode="&#x627;" arabic-form="final" horiz-adv-x="1"/>'),
        );
    });

    it("keeps the isolated form of a letter whose other glyph has a form fontforge does not know", async function () {
        // fontforge reads such a glyph under the letter, as one without a form.
        const glyphs =
            '<glyph unicode="&#x628;" arabic-form="isolated" horiz-adv-x="1"/><glyph unicode="&#x628;" arabic-form="Isolated" horiz-adv-x="1"/>';

        expect(await prepared(fontDocument("0", glyphs))).to.equal(fontDocument("0", glyphs));
    });

    it("keeps the isolated form of a ligature", async function () {
        const source = fontDocument("0", '<glyph unicode="&#x644;&#x627;" arabic-form="isolated" horiz-adv-x="1"/>');

        expect(await prepared(source)).to.equal(source);
    });

    it("writes the initial and medial forms of U+0649 under their presentation forms", async function () {
        // The span of the first attribute starts after the whitespace character that ends the name, so
        // a unicode written in place of it stands after two spaces.
        const glyphs =
            '<glyph unicode="&#x649;" arabic-form="initial" horiz-adv-x="1"/><glyph arabic-form="medial" unicode="&#x649;" horiz-adv-x="1"/>' +
            '<glyph unicode="&#x649;" arabic-form="final" horiz-adv-x="1"/>';

        expect(await prepared(fontDocument("0", glyphs))).to.equal(
            fontDocument(
                "0",
                '<glyph  unicode="&#xFBE8;" horiz-adv-x="1"/><glyph  unicode="&#xFBE9;" horiz-adv-x="1"/>' +
                    '<glyph unicode="&#x649;" arabic-form="final" horiz-adv-x="1"/>',
            ),
        );
    });

    it("takes the isolated form off U+0649 when its initial form goes under U+FBE8", async function () {
        const glyphs =
            '<glyph unicode="&#x649;" arabic-form="isolated" horiz-adv-x="1"/><glyph unicode="&#x649;" arabic-form="initial" horiz-adv-x="1"/>';

        expect(await prepared(fontDocument("0", glyphs))).to.equal(
            fontDocument("0", '<glyph unicode="&#x649;" horiz-adv-x="1"/><glyph  unicode="&#xFBE8;" horiz-adv-x="1"/>'),
        );
    });

    it("keeps the initial form of U+0649 when a glyph already has U+FBE8", async function () {
        const source = fontDocument(
            "0",
            '<glyph unicode="&#xFBE8;" horiz-adv-x="1"/><glyph unicode="&#x649;" arabic-form="initial" horiz-adv-x="1"/>',
        );

        expect(await prepared(source)).to.equal(source);
    });

    it("writes only the first initial form of U+0649 under U+FBE8", async function () {
        const secondInitialForm = '<glyph unicode="&#x649;" arabic-form="initial" horiz-adv-x="2"/>';
        const glyphs = `<glyph unicode="&#x649;" arabic-form="initial" horiz-adv-x="1"/>${secondInitialForm}`;

        expect(await prepared(fontDocument("0", glyphs))).to.equal(
            fontDocument("0", `<glyph  unicode="&#xFBE8;" horiz-adv-x="1"/>${secondInitialForm}`),
        );
    });

    it("keeps the isolated form of U+0649 when its initial form stays under the letter, wherever that glyph stands", async function () {
        // fontforge reads the initial form left in place under U+0649, and the isolated one under U+FEEF.
        const isolatedForm = '<glyph unicode="&#x649;" arabic-form="isolated" horiz-adv-x="1"/>';
        const presentationForm = '<glyph unicode="&#xFBE8;" horiz-adv-x="1"/>';
        const initialForm = '<glyph unicode="&#x649;" arabic-form="initial" horiz-adv-x="1"/>';
        const isolatedFormFirst = fontDocument("0", isolatedForm + presentationForm + initialForm);
        const isolatedFormLast = fontDocument("0", presentationForm + initialForm + isolatedForm);

        expect(await prepared(isolatedFormFirst)).to.equal(isolatedFormFirst);
        expect(await prepared(isolatedFormLast)).to.equal(isolatedFormLast);
    });

    it("writes the initial form of U+0649 under U+FBE8 past a <missing-glyph> with the same form", async function () {
        const missingGlyph = '<missing-glyph unicode="&#x649;" arabic-form="initial" horiz-adv-x="1"/>';
        const glyphs = `${missingGlyph}<glyph unicode="&#x649;" arabic-form="initial" horiz-adv-x="1"/>`;

        expect(await prepared(fontDocument("0", glyphs))).to.equal(
            fontDocument("0", `${missingGlyph}<glyph  unicode="&#xFBE8;" horiz-adv-x="1"/>`),
        );
    });

    it("leaves the terminal form of <missing-glyph> as it is", async function () {
        // fontforge reads <missing-glyph> as .notdef, whatever its form says.
        const source = fontDocument("0", '<missing-glyph unicode="&#x627;" arabic-form="terminal" horiz-adv-x="1"/>');

        expect(await prepared(source)).to.equal(source);
    });

    it("cuts the form out together with the whitespace before it, wherever the tag breaks", async function () {
        const glyphs =
            '<glyph arabic-form = \'isolated\'\r\n unicode="&#x627;"/><glyph\tunicode="&#x62A;"\n\tarabic-form="isolated" d="M0 0h1">\n</glyph>';

        expect(await prepared(fontDocument("0", glyphs))).to.equal(
            fontDocument(
                "0",
                '<glyph \r\n unicode="&#x627;" horiz-adv-x="0"/><glyph\tunicode="&#x62A;" d="M0 0h1" horiz-adv-x="0">\n</glyph>',
            ),
        );
    });

    it("keeps the rest of the file byte for byte", async function () {
        const source = `<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n<!-- <glyph/> -->${fontDocument(
            "0",
            '<glyph unicode="&amp;"/><![CDATA[<glyph/>]]>',
        )}`;

        expect(await prepared(source)).to.equal(source.replace('<glyph unicode="&amp;"/>', '<glyph unicode="&amp;" horiz-adv-x="0"/>'));
    });

    it("answers the indexes of the glyph elements SVG 1.1 maps to no code point", async function () {
        // A character outside the BMP is one code point, though two UTF-16 units. A `missing-glyph` is
        // unencoded whatever it says, and the elements other than glyph and missing-glyph do not count.
        const glyphs =
            '<glyph unicode="a" horiz-adv-x="1"/><missing-glyph unicode="b"/><glyph glyph-name="Ldot"/><hkern g1="a" g2="b" k="1"/>' +
            '<glyph unicode="\u{1F600}"/><glyph unicode="fi"/><glyph unicode=""/><glyph unicode="&#x41;"/>';

        expect(await unencodedGlyphIndexesOf(fontDocument("0", glyphs))).to.deep.equal([1, 2, 4, 5]);
    });

    it("counts only the glyph elements that are children of <font>", async function () {
        const source = `<svg xmlns="${SVG_NAMESPACE}"><glyph/><font horiz-adv-x="0">${FONT_FACE}<g><glyph/></g><s:glyph xmlns:s="${SVG_NAMESPACE}"/><glyph unicode="a"/></font></svg>`;

        expect(await unencodedGlyphIndexesOf(source)).to.deep.equal([0]);
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

    async function unencodedGlyphIndexesOf(source: string): Promise<Array<number>> {
        await fs.writeFile(sourcePath, source);

        return preparer.prepare(sourcePath, preparedPath);
    }

    function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
        return call().then(
            () => expect.fail("call did not throw"),
            (error: unknown) => error,
        );
    }
});
