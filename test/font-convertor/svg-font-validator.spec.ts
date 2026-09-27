import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import zlib from "zlib";
import { Extension } from "app/font-convertor/font-convertor.types";
import { SvgFontValidator } from "app/font-convertor/svg-validator/svg-font-validator";
import type { InvalidSvgFont } from "app/font-convertor/svg-validator/svg-font-validator.errors";
import { BrokenFont, NoFont, NotSvg, NotXml } from "app/font-convertor/svg-validator/svg-font-validator.errors";
import { FontRule } from "app/font-convertor/svg-validator/svg-font-validator.types";
import { ReadFailed } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const validator = new SvgFontValidator();

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SVG_ROOT = `{${SVG_NAMESPACE}}svg`;
const SVG11_DOCTYPE = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">';
const FONT_FACE = '<font-face units-per-em="1000"/>';
const GLYPH = '<glyph horiz-adv-x="500"/>';
const FONT = `<font horiz-adv-x="500">${FONT_FACE}${GLYPH}</font>`;
// A font whose font-face points at a font file through xlink:href.
const XLINK_FONT = `<font horiz-adv-x="500"><font-face units-per-em="1000"><font-face-src><font-face-uri xlink:href="f.svg#f"/></font-face-src></font-face>${GLYPH}</font>`;

// An inline document: the font lies on line 2, the line the messages name.
function inline(font: string): string {
    return `<svg xmlns="${SVG_NAMESPACE}">\n${font}\n</svg>`;
}

describe("SvgFontValidator.validate", function () {
    let workDir: string;
    let fixture: string;
    // The fixture with neither the XML declaration nor its line break: a document for the prologues.
    let bare: string;

    before(async function () {
        fixture = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.SVG}`), "utf8");
        bare = fixture.replace(/^<\?xml[^>]*>\n/, "");
    });

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "svg-font-validator-"));
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    describe("accepts a valid font", function () {
        it("the Roboto fixture", async function () {
            await validate(fixture);
        });

        it("with a UTF-8 BOM", async function () {
            await validate(concat([0xef, 0xbb, 0xbf], Buffer.from(fixture, "utf8")));
        });

        it("in UTF-16 of either byte order with a BOM", async function () {
            await validate(utf16le(fixture));
            await validate(utf16be(fixture));
        });

        it("opening with a comment or a processing instruction of any target", async function () {
            // The prologues of #196: the engine converts all three.
            await validate(`<!-- editor -->${bare}`);
            await validate(`\n<?xml-stylesheet href="a.css"?>${bare}`);
            await validate(`<?sodipodi-namespace?>${bare}`);
        });

        it("without the XML declaration", async function () {
            await validate(bare);
        });

        it("whose font does not lie in defs", async function () {
            await validate(fixture.replace("<defs>\n", "").replace("</defs>", ""));
        });

        it("in the SVG namespace bound to a prefix", async function () {
            await validate(
                `<s:svg xmlns:s="${SVG_NAMESPACE}"><s:font horiz-adv-x="500"><s:font-face units-per-em="1000"/><s:glyph/></s:font></s:svg>`,
            );
        });

        it("without xmlns under the SVG 1.1 DOCTYPE", async function () {
            // The DTD declares xmlns of svg #FIXED to the SVG namespace; Font Awesome 4.7 is written this way.
            await validate(fixture.replace(` xmlns="${SVG_NAMESPACE}"`, ""));
            await validate(`<!DOCTYPE svg PUBLIC  '-//W3C//DTD SVG 1.1//EN' 'svg11.dtd'><svg>${FONT}</svg>`);
        });

        it("without xmlns:xlink under the SVG 1.1 DOCTYPE", async function () {
            // The DTD fixes xmlns:xlink of svg the same way.
            await validate(`${SVG11_DOCTYPE}<svg>${XLINK_FONT}</svg>`);
        });

        it("with an encoding declaration naming the encoding it is read in", async function () {
            await validate(`<?xml version="1.0" encoding="UTF-8"?>${inline(FONT)}`);
            await validate(`<?xml version="1.0" encoding="utf-8"?>${inline(FONT)}`);
            await validate(utf16le(`<?xml version="1.0" encoding="UTF-16"?>${inline(FONT)}`));
            await validate(utf16le(`<?xml version="1.0" encoding="UTF-16LE"?>${inline(FONT)}`));
            await validate(utf16be(`<?xml version="1.0" encoding="UTF-16"?>${inline(FONT)}`));
            await validate(utf16be(`<?xml version="1.0" encoding="UTF-16BE"?>${inline(FONT)}`));
        });

        it("with numbers in every form the attribute grammar allows", async function () {
            for (const value of ["0", "55", "-5", "+5", ".5", "12.25", "1e10", "1E-3", "-1.5e+3"]) {
                await validate(inline(`<font horiz-adv-x="500" horiz-origin-x="${value}">${FONT_FACE}${GLYPH}</font>`));
            }
        });

        it("with a zero advance", async function () {
            await validate(inline(`<font horiz-adv-x="0">${FONT_FACE}<glyph horiz-adv-x="0"/></font>`));
            await validate(inline(`<font horiz-adv-x="-0">${FONT_FACE}<glyph horiz-adv-x="-0.0e5"/></font>`));
        });

        it("with a units-per-em whose number rounds off its range", async function () {
            // The sign is read off the text: as a double, 1e-999 is zero and 1e999 is Infinity.
            await validate(inline(`<font horiz-adv-x="500"><font-face units-per-em="1e-999"/>${GLYPH}</font>`));
            await validate(inline(`<font horiz-adv-x="500"><font-face units-per-em="1e999"/>${GLYPH}</font>`));
        });

        it("ignoring prefixed attributes and elements outside a font", async function () {
            // Only unprefixed attributes are SVG attributes of these elements, and a glyph outside
            // a font is no part of it.
            await validate(inline(`<font horiz-adv-x="500" xmlns:x="urn:x" x:horiz-adv-x="-1">${FONT_FACE}${GLYPH}</font>`));
            await validate(inline(`<glyph horiz-adv-x="-1"/>${FONT}`));
        });
    });

    describe("answers not XML", function () {
        for (const extension of [Extension.TTF, Extension.OTF, Extension.WOFF, Extension.WOFF2, Extension.EOT]) {
            it(`to a binary ${extension} fixture named .svg`, async function () {
                await expectAnswer(await fs.readFile(path.join(fixtureDir, `test-font.${extension}`)), NotXml);
            });
        }

        it("to a gzipped fixture", async function () {
            await expectAnswer(zlib.gzipSync(fixture), NotXml);
        });

        it("to plain text", async function () {
            await expectAnswer("a font", NotXml, "File is not XML: 1:6: text data outside of root node.");
        });

        it("to an empty file", async function () {
            await expectAnswer("", NotXml, "File is not XML: 1:0: document must contain a root element.");
        });

        it("to a truncated fixture", async function () {
            await expectAnswer(fixture.slice(0, fixture.length / 2), NotXml);
        });

        it("to an XML declaration after an indent", async function () {
            await expectAnswer(`  ${fixture}`, NotXml, "File is not XML: 1:8: an XML declaration must be at the start of the document.");
        });

        it("to bytes that are not UTF-8", async function () {
            const error = await expectAnswer(
                concat(Buffer.from("<svg><!-- "), [0xc3, 0x28], Buffer.from(" --></svg>")),
                NotXml,
                "File is not XML: its bytes are not valid utf-8.",
            );

            expect(error.payload).to.deep.equal({ encoding: "utf-8" });
            expect(error.cause).to.be.instanceOf(TypeError);
        });

        it("to UTF-16 with an odd number of bytes", async function () {
            await expectAnswer(concat(utf16le(inline(FONT)), [0x20]), NotXml, "File is not XML: its bytes are not valid utf-16le.");
            await expectAnswer(concat(utf16be(inline(FONT)), [0x20]), NotXml, "File is not XML: its bytes are not valid utf-16be.");
        });

        it("to UTF-16 without a BOM", async function () {
            // Read as UTF-8, the zero byte of every character is a character XML does not allow.
            await expectAnswer(Buffer.from(inline(FONT), "utf16le"), NotXml, "File is not XML: 1:2: disallowed character.");
        });

        it("to an encoding declaration naming another encoding", async function () {
            const utf8Error = await expectAnswer(
                `<?xml version="1.0" encoding="ISO-8859-1"?>${inline(FONT)}`,
                NotXml,
                "File is not XML: 1:43: the encoding declaration names ISO-8859-1, while the file is read as utf-8.",
            );
            await expectAnswer(
                utf16le(`<?xml version="1.0" encoding="UTF-16BE"?>${inline(FONT)}`),
                NotXml,
                "File is not XML: 1:41: the encoding declaration names UTF-16BE, while the file is read as utf-16le.",
            );
            await expectAnswer(
                utf16be(`<?xml version="1.0" encoding="UTF-16LE"?>${inline(FONT)}`),
                NotXml,
                "File is not XML: 1:41: the encoding declaration names UTF-16LE, while the file is read as utf-16be.",
            );
            await expectAnswer(
                utf16le(`<?xml version="1.0" encoding="UTF-8"?>${inline(FONT)}`),
                NotXml,
                "File is not XML: 1:38: the encoding declaration names UTF-8, while the file is read as utf-16le.",
            );

            expect(utf8Error.cause).to.be.instanceOf(Error);
        });

        it("to a reference XML 1.0 forbids, whatever version the document declares", async function () {
            // XML 1.1 allows a reference to a control character; the fifth edition of XML 1.0 reads
            // a 1.1 document as 1.0.
            await expectAnswer(
                `<?xml version="1.1"?>${inline(`&#x1;${FONT}`)}`,
                NotXml,
                "File is not XML: 2:5: malformed character entity.",
            );
        });

        it("to an undeclared xlink prefix outside the SVG 1.1 DOCTYPE", async function () {
            await expectAnswer(inline(XLINK_FONT), NotXml, 'File is not XML: 2:107: unbound namespace prefix: "xlink".');
        });

        it("to an xlink attribute repeated through another prefix under the SVG 1.1 DOCTYPE", async function () {
            // The DOCTYPE binds xlink to the XLink namespace itself, so xl:href is the same attribute.
            await expectAnswer(
                `${SVG11_DOCTYPE}<svg><a xlink:href="a" xl:href="b" xmlns:xl="http://www.w3.org/1999/xlink"/></svg>`,
                NotXml,
                "File is not XML: 1:174: duplicate attribute: {http://www.w3.org/1999/xlink}href.",
            );
        });

        it("to an unbound prefix under the SVG 1.1 DOCTYPE", async function () {
            // The DOCTYPE binds only the prefixes the DTD fixes.
            await expectAnswer(`${SVG11_DOCTYPE}<svg><x:font/></svg>`, NotXml, 'File is not XML: 1:112: unbound namespace prefix: "x".');
        });

        it("before any other answer", async function () {
            // The root is not SVG and the font is broken, but the document breaks off: the first
            // answer wins.
            await expectAnswer(`<html><font xmlns="${SVG_NAMESPACE}">`, NotXml, "File is not XML: 1:47: unclosed tag: font");
        });
    });

    describe("answers not SVG", function () {
        it("to a root outside the SVG namespace", async function () {
            const error = await expectAnswer(
                '<html xmlns="http://www.w3.org/1999/xhtml"/>',
                NotSvg,
                `File is not SVG: the root element is {http://www.w3.org/1999/xhtml}html, expected ${SVG_ROOT}.`,
            );

            expect(error.payload).to.deep.equal({ root: "{http://www.w3.org/1999/xhtml}html" });
        });

        it("to an svg root without xmlns and without the SVG 1.1 DOCTYPE", async function () {
            const message = `File is not SVG: the root element is {}svg, expected ${SVG_ROOT}.`;
            const withoutXmlns = bare.replace(` xmlns="${SVG_NAMESPACE}"`, "");

            await expectAnswer(withoutXmlns.replace(/^<!DOCTYPE[^>]*>\n/, ""), NotSvg, message);
            await expectAnswer(withoutXmlns.replace("SVG 1.1", "SVG 20010904"), NotSvg, message);
        });

        it("to a root of another name in the SVG namespace", async function () {
            await expectAnswer(
                `<font xmlns="${SVG_NAMESPACE}"/>`,
                NotSvg,
                `File is not SVG: the root element is {${SVG_NAMESPACE}}font, expected ${SVG_ROOT}.`,
            );
        });

        it("quoting a long root cut to 64 characters", async function () {
            const error = await expectAnswer(
                `<x xmlns="urn:${"a".repeat(100)}"/>`,
                NotSvg,
                `File is not SVG: the root element is {urn:${"a".repeat(59)}…, expected ${SVG_ROOT}.`,
            );

            expect(error.payload).to.deep.equal({ root: `{urn:${"a".repeat(59)}…` });
        });

        it("before no font and a broken font", async function () {
            await expectAnswer(
                `<html><font xmlns="${SVG_NAMESPACE}"/></html>`,
                NotSvg,
                `File is not SVG: the root element is {}html, expected ${SVG_ROOT}.`,
            );
        });
    });

    describe("answers no font", function () {
        it("to an svg without a font element", async function () {
            await expectAnswer(inline("<g/>"), NoFont, "SVG has no font element in the SVG namespace.");
        });

        it("to a font element outside the SVG namespace", async function () {
            await expectAnswer(inline('<font xmlns="urn:x"/>'), NoFont, "SVG has no font element in the SVG namespace.");
        });
    });

    describe("answers a broken font", function () {
        it("to a font without horiz-adv-x", async function () {
            const error = await expectAnswer(
                inline(`<font>${FONT_FACE}${GLYPH}</font>`),
                BrokenFont,
                "SVG font breaks a rule: font has horiz-adv-x (SVG 1.1, Appendix A.3.39). At line 2: <font>.",
            );

            expect(error.payload).to.deep.equal({
                rule: FontRule.AdvanceRequired,
                element: "font",
                line: 2,
                attribute: undefined,
                value: undefined,
            });
        });

        const numericAttributes: Record<string, Array<string>> = {
            font: ["horiz-origin-x", "horiz-origin-y", "horiz-adv-x", "vert-origin-x", "vert-origin-y", "vert-adv-y"],
            glyph: ["horiz-adv-x", "vert-origin-x", "vert-origin-y", "vert-adv-y"],
            "missing-glyph": ["horiz-adv-x", "vert-origin-x", "vert-origin-y", "vert-adv-y"],
        };

        for (const [element, attributes] of Object.entries(numericAttributes)) {
            for (const attribute of attributes) {
                it(`to ${attribute} of ${element} that is not a number`, async function () {
                    const fonts: Record<string, string> = {
                        font: `<font ${
                            attribute === "horiz-adv-x" ? "" : 'horiz-adv-x="500" '
                        }${attribute}="5.">${FONT_FACE}${GLYPH}</font>`,
                        glyph: `<font horiz-adv-x="500">${FONT_FACE}<glyph ${attribute}="5."/></font>`,
                        "missing-glyph": `<font horiz-adv-x="500">${FONT_FACE}<missing-glyph ${attribute}="5."/>${GLYPH}</font>`,
                    };

                    const error = await expectAnswer(
                        inline(fonts[element] as string),
                        BrokenFont,
                        `SVG font breaks a rule: a numeric attribute is a <number> (SVG 1.1, §4.2). At line 2: <${element}> with ${attribute}="5.".`,
                    );

                    expect(error.payload).to.deep.equal({
                        rule: FontRule.Number,
                        element: element,
                        line: 2,
                        attribute: attribute,
                        value: "5.",
                    });
                });
            }
        }

        it("to a number in a form the attribute grammar does not allow", async function () {
            // `5.` is a number in path data, but not in an attribute (§4.2).
            for (const value of ["5.", "x5", "5x", "", "e3", "1e", "1.2.3", " 5", "5 ", "1e+", "--5"]) {
                await expectAnswer(
                    inline(`<font horiz-adv-x="500" horiz-origin-x="${value}">${FONT_FACE}${GLYPH}</font>`),
                    BrokenFont,
                    `SVG font breaks a rule: a numeric attribute is a <number> (SVG 1.1, §4.2). At line 2: <font> with horiz-origin-x=${JSON.stringify(
                        value,
                    )}.`,
                );
            }
        });

        it("quoting a long value cut to 64 characters", async function () {
            const cases: Array<[string, string]> = [
                ["x".repeat(64), "x".repeat(64)],
                ["x".repeat(65), `${"x".repeat(64)}…`],
                // The cut falls inside a surrogate pair: its half is not valid UTF-8 on the way out.
                [`${"x".repeat(63)}😀x`, `${"x".repeat(63)}\uFFFD…`],
            ];

            for (const [value, quoted] of cases) {
                const error = await expectAnswer(
                    inline(`<font horiz-adv-x="500" horiz-origin-x="${value}">${FONT_FACE}${GLYPH}</font>`),
                    BrokenFont,
                    `SVG font breaks a rule: a numeric attribute is a <number> (SVG 1.1, §4.2). At line 2: <font> with horiz-origin-x=${JSON.stringify(
                        quoted,
                    )}.`,
                );

                expect(error.payload).to.include({ attribute: "horiz-origin-x", value: quoted });
            }
        });

        for (const element of ["font", "glyph", "missing-glyph"]) {
            it(`to a negative horiz-adv-x of ${element}`, async function () {
                const fonts: Record<string, string> = {
                    font: `<font horiz-adv-x="-1">${FONT_FACE}${GLYPH}</font>`,
                    glyph: `<font horiz-adv-x="500">${FONT_FACE}<glyph horiz-adv-x="-1"/></font>`,
                    "missing-glyph": `<font horiz-adv-x="500">${FONT_FACE}<missing-glyph horiz-adv-x="-1"/>${GLYPH}</font>`,
                };

                await expectAnswer(
                    inline(fonts[element] as string),
                    BrokenFont,
                    `SVG font breaks a rule: horiz-adv-x is not negative (SVG 1.1, §20.3, §20.4). At line 2: <${element}> with horiz-adv-x="-1".`,
                );
            });
        }

        it("to a negative horiz-adv-x whose number rounds to zero", async function () {
            await expectAnswer(
                inline(`<font horiz-adv-x="-1e-999">${FONT_FACE}${GLYPH}</font>`),
                BrokenFont,
                'SVG font breaks a rule: horiz-adv-x is not negative (SVG 1.1, §20.3, §20.4). At line 2: <font> with horiz-adv-x="-1e-999".',
            );
        });

        it("to a font without a font-face child", async function () {
            const message = "SVG font breaks a rule: font has a font-face child (SVG 1.1, §20.3). At line 2: <font>.";

            await expectAnswer(inline(`<font horiz-adv-x="500">${GLYPH}</font>`), BrokenFont, message);
            // Only a direct child in the SVG namespace counts.
            await expectAnswer(inline(`<font horiz-adv-x="500"><g>${FONT_FACE}</g>${GLYPH}</font>`), BrokenFont, message);
            await expectAnswer(inline(`<font horiz-adv-x="500"><font-face xmlns="urn:x"/>${GLYPH}</font>`), BrokenFont, message);
        });

        it("to a font-face without units-per-em", async function () {
            await expectAnswer(
                inline(`<font horiz-adv-x="500"><font-face/>${GLYPH}</font>`),
                BrokenFont,
                "SVG font breaks a rule: font-face has units-per-em (ours: fontforge does not open a font without it). At line 2: <font-face>.",
            );
        });

        it("to units-per-em that is not a number", async function () {
            await expectAnswer(
                inline(`<font horiz-adv-x="500"><font-face units-per-em="1000."/>${GLYPH}</font>`),
                BrokenFont,
                'SVG font breaks a rule: a numeric attribute is a <number> (SVG 1.1, §4.2). At line 2: <font-face> with units-per-em="1000.".',
            );
        });

        it("to units-per-em that is not positive", async function () {
            for (const value of ["0", "-1000", "-0", "0.0", "0e15"]) {
                await expectAnswer(
                    inline(`<font horiz-adv-x="500"><font-face units-per-em="${value}"/>${GLYPH}</font>`),
                    BrokenFont,
                    `SVG font breaks a rule: units-per-em is positive (SVG 1.1, §20.8.3). At line 2: <font-face> with units-per-em="${value}".`,
                );
            }
        });

        it("to a font without a glyph child", async function () {
            const message =
                "SVG font breaks a rule: font has a glyph child (ours: fontforge turns a font without glyphs into an empty one). At line 2: <font>.";

            await expectAnswer(inline(`<font horiz-adv-x="500">${FONT_FACE}</font>`), BrokenFont, message);
            // A missing-glyph is not a glyph, and only a direct child in the SVG namespace counts.
            await expectAnswer(inline(`<font horiz-adv-x="500">${FONT_FACE}<missing-glyph/></font>`), BrokenFont, message);
            await expectAnswer(inline(`<font horiz-adv-x="500">${FONT_FACE}<g>${GLYPH}</g></font>`), BrokenFont, message);
            await expectAnswer(inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph xmlns="urn:x"/></font>`), BrokenFont, message);
        });

        it("to a broken font after a valid one", async function () {
            await expectAnswer(
                inline(`${FONT}\n<font horiz-adv-x="-1">${FONT_FACE}${GLYPH}</font>`),
                BrokenFont,
                'SVG font breaks a rule: horiz-adv-x is not negative (SVG 1.1, §20.3, §20.4). At line 3: <font> with horiz-adv-x="-1".',
            );
        });

        it("naming the first rule broken", async function () {
            await expectAnswer(
                inline("<font></font>"),
                BrokenFont,
                "SVG font breaks a rule: font has horiz-adv-x (SVG 1.1, Appendix A.3.39). At line 2: <font>.",
            );
            await expectAnswer(
                inline('<font horiz-adv-x="500"></font>'),
                BrokenFont,
                "SVG font breaks a rule: font has a font-face child (SVG 1.1, §20.3). At line 2: <font>.",
            );
        });

        it("naming the line the start tag opens on", async function () {
            // saxes reports the tag once the character after its name is read; a line break there
            // must not move the line on.
            await expectAnswer(
                inline(`<font horiz-adv-x="500">\n${FONT_FACE}\n<glyph\nhoriz-adv-x="-1"\n/></font>`),
                BrokenFont,
                'SVG font breaks a rule: horiz-adv-x is not negative (SVG 1.1, §20.3, §20.4). At line 4: <glyph> with horiz-adv-x="-1".',
            );
        });
    });

    it("throws ReadFailed, not an answer, on a file that cannot be read", async function () {
        try {
            await validator.validate(path.join(workDir, `missing.${Extension.SVG}`));
        } catch (error) {
            expect(error).to.be.instanceOf(ReadFailed);

            return;
        }

        expect.fail("validate did not throw ReadFailed");
    });

    async function validate(content: string | Uint8Array): Promise<void> {
        const filePath = path.join(workDir, `font.${Extension.SVG}`);

        await fs.writeFile(filePath, content);
        await validator.validate(filePath);
    }

    async function expectAnswer<T extends InvalidSvgFont>(
        content: string | Uint8Array,
        expected: new (...params: never) => T,
        message?: string,
    ): Promise<T> {
        try {
            await validate(content);
        } catch (error) {
            expect(error).to.be.instanceOf(expected);

            if (message !== undefined) {
                expect((error as T).message).to.equal(message);
            }

            return error as T;
        }

        return expect.fail(`validate did not throw ${expected.name}`);
    }
});

function concat(...parts: Array<Uint8Array | Array<number>>): Uint8Array {
    return Buffer.concat(parts.map((part) => Uint8Array.from(part)));
}

function utf16le(text: string): Uint8Array {
    return concat([0xff, 0xfe], Buffer.from(text, "utf16le"));
}

function utf16be(text: string): Uint8Array {
    return concat([0xfe, 0xff], Buffer.from(text, "utf16le").swap16());
}
