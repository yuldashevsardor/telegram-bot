import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import zlib from "zlib";
import { Extension } from "app/font-convertor/font-convertor.types";
import { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import type { InvalidSvgFont } from "app/font-convertor/validator/svg/svg-font-validator.errors";
import { BrokenFont, NoFont, NotSvg, NotXml } from "app/font-convertor/validator/svg/svg-font-validator.errors";
import { FontRule } from "app/font-convertor/validator/svg/svg-font-validator.types";
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

// A valid font with the kerning pairs given after its glyphs.
function kerned(kerning: string): string {
    return `<font horiz-adv-x="500">${FONT_FACE}<glyph glyph-name="a" unicode="a"/><glyph glyph-name="b" unicode="b"/>${kerning}</font>`;
}

describe("SvgFontValidator.validate", function () {
    let workDir: string;
    // The file every inline document is written to: each answer names it in its payload.
    let fontPath: string;
    let fixture: string;
    // The fixture with neither the XML declaration nor its line break: a document for the prologues.
    let bare: string;

    before(async function () {
        fixture = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.SVG}`), "utf8");
        bare = fixture.replace(/^<\?xml[^>]*>\n/, "");
    });

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "svg-font-validator-"));
        fontPath = path.join(workDir, `font.${Extension.SVG}`);
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

        it("opening with a comment or a processing instruction whose target names no font node", async function () {
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

        it("with glyph outlines in path data, an empty one included", async function () {
            await validate(
                inline(
                    `<font horiz-adv-x="500">${FONT_FACE}<missing-glyph d="M0 0h500v700h-500z"/><glyph d="M 100-200 L0.6.5"/><glyph d=""/></font>`,
                ),
            );
        });

        it("ignoring namespace declarations and elements outside a font", async function () {
            // A namespace declaration is no attribute, and a glyph outside a font is no part of it.
            await validate(inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph xmlns:d="urn:x" d="M0 0"/></font>`));
            await validate(inline(`<glyph horiz-adv-x="-1"/>${FONT}`));
            await validate(inline(`<g><glyph x:d="garbage" xmlns:x="urn:x"><path d="garbage"/></glyph></g>${FONT}`));
            await validate(inline(`<hkern u1="ab" k="x"/>${FONT}`));
        });

        it("with a DOCTYPE that has no internal subset", async function () {
            await validate(`<!DOCTYPE svg>\n${inline(FONT)}`);
            await validate(`<!DOCTYPE svg SYSTEM "a]" >\n${inline(FONT)}`);
            await validate(`<!DOCTYPE svg SYSTEM 'a[' >\n${inline(FONT)}`);
        });

        it("with text or a comment inside a glyph", async function () {
            await validate(inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph d="M0 0"> <!-- path --> </glyph></font>`));
        });

        it("with kerning pairs in the forms real fonts write", async function () {
            // u1="," is a single character, not a list: 13 of the 24 real fonts checked for #776 hold it.
            await validate(inline(kerned('<hkern u1="," u2="a" k="-50"/><vkern u1="a" u2="b" k="12.5"/>')));
            await validate(inline(kerned('<hkern g1="a,b c" g2="unknown" k="50"/><hkern u1="a" g1="b" u2="b" k="0"/>')));
            // A no-break space is no XML whitespace: it is a name, though no glyph has it.
            await validate(inline(kerned('<hkern g1="&#xA0;" u2="b" k="50"/>')));
            // A character outside the BMP is one code point, though two UTF-16 units.
            await validate(inline(kerned('<hkern u1="😀" u2="&#x1F600;" k="50"/>')));
        });

        it("with a k whose number rounds off its range", async function () {
            // No number is checked for its range: fontforge makes a pair of zero of 1e999.
            await validate(inline(kerned('<hkern u1="a" u2="b" k="1e999"/><hkern u1="a" u2="b" k="1e-999"/>')));
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

            expect(error.payload).to.deep.equal({ path: fontPath, encoding: "utf-8" });
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

            expect(utf8Error.cause).to.equal(undefined);
        });

        it("quoting the parser message cut to 200 UTF-16 units", async function () {
            const declared = "A".repeat(300);
            const declaration = `<?xml version="1.0" encoding="${declared}"?>`;
            const parserMessage = `1:${declaration.length}: the encoding declaration names ${declared}, while the file is read as utf-8.`;

            await expectAnswer(`${declaration}${inline(FONT)}`, NotXml, `File is not XML: ${parserMessage.slice(0, 200)}…`);
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

            expect(error.payload).to.deep.equal({ path: fontPath, root: "{http://www.w3.org/1999/xhtml}html", rootLength: 34 });
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

        it("quoting the namespace and the local name of a root each cut to 64 UTF-16 units", async function () {
            // A long namespace must not cut off the local name, and the braces stay around the namespace.
            const namespace = `urn:${"a".repeat(100)}`;
            const local = "b".repeat(100);
            const cases: Array<[string, string, number]> = [
                [`<x xmlns="${namespace}"/>`, `{urn:${"a".repeat(60)}…}x`, 107],
                [`<${local} xmlns="urn:a"/>`, `{urn:a}${"b".repeat(64)}…`, 107],
                [`<${local} xmlns="${namespace}"/>`, `{urn:${"a".repeat(60)}…}${"b".repeat(64)}…`, 206],
                // The limit applies to the namespace alone, not counting the braces.
                [`<x xmlns="urn:${"a".repeat(60)}"/>`, `{urn:${"a".repeat(60)}}x`, 67],
                [`<x xmlns="urn:${"a".repeat(61)}"/>`, `{urn:${"a".repeat(60)}…}x`, 68],
                // A namespace may hold `}`, a local name may not: the name follows the last one.
                [`<x xmlns="urn:}${"a".repeat(100)}"/>`, `{urn:}${"a".repeat(59)}…}x`, 108],
            ];

            for (const [document, quoted, rootLength] of cases) {
                const error = await expectAnswer(document, NotSvg, `File is not SVG: the root element is ${quoted}, expected ${SVG_ROOT}.`);

                expect(error.payload).to.deep.equal({ path: fontPath, root: quoted, rootLength: rootLength });
            }
        });

        it("quoting the namespace escaped in the message and unescaped in the payload", async function () {
            // A line break must not split the message, while the length of the payload's quote still tells a cut.
            const cases: Array<[string, string, string]> = [
                [`<x xmlns="urn:a&#10;b\\c"/>`, String.raw`{urn:a\nb\\c}x`, "{urn:a\nb\\c}x"],
                [`<x xmlns="urn:${"\\".repeat(70)}"/>`, `{urn:${"\\\\".repeat(60)}…}x`, `{urn:${"\\".repeat(60)}…}x`],
            ];

            for (const [document, escaped, quoted] of cases) {
                const error = await expectAnswer(
                    document,
                    NotSvg,
                    `File is not SVG: the root element is ${escaped}, expected ${SVG_ROOT}.`,
                );

                expect(error.payload).to.include({ root: quoted });
            }
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

        it("rather than the namespace rule, to two font elements outside the SVG namespace", async function () {
            await expectAnswer(
                inline('<font xmlns="urn:x"/><font xmlns="urn:x"/>'),
                NoFont,
                "SVG has no font element in the SVG namespace.",
            );
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
                path: fontPath,
                rule: FontRule.AdvanceRequired,
                element: "font",
                line: 2,
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
                        path: fontPath,
                        rule: FontRule.Number,
                        element: element,
                        line: 2,
                        attribute: attribute,
                        value: "5.",
                        valueLength: 2,
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

        it("quoting a long value cut to 64 UTF-16 units, the mark outside the quotes", async function () {
            const cases: Array<[string, string, string]> = [
                ["x".repeat(64), `"${"x".repeat(64)}"`, "x".repeat(64)],
                ["x".repeat(65), `"${"x".repeat(64)}"…`, `${"x".repeat(64)}…`],
                // The cut falls inside a surrogate pair: its half is not valid UTF-8 on the way out.
                [`${"x".repeat(63)}😀x`, `"${"x".repeat(63)}\uFFFD"…`, `${"x".repeat(63)}\uFFFD…`],
            ];

            for (const [value, quoted, payloadValue] of cases) {
                const error = await expectAnswer(
                    inline(`<font horiz-adv-x="500" horiz-origin-x="${value}">${FONT_FACE}${GLYPH}</font>`),
                    BrokenFont,
                    `SVG font breaks a rule: a numeric attribute is a <number> (SVG 1.1, §4.2). At line 2: <font> with horiz-origin-x=${quoted}.`,
                );

                expect(error.payload).to.include({ value: payloadValue, valueLength: value.length });
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

        for (const element of ["glyph", "missing-glyph"]) {
            it(`to d of ${element} that is not path data`, async function () {
                const glyphs: Record<string, string> = {
                    glyph: '<glyph d="L0 0"/>',
                    "missing-glyph": `<missing-glyph d="L0 0"/>${GLYPH}`,
                };

                const error = await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}${glyphs[element] as string}</font>`),
                    BrokenFont,
                    `SVG font breaks a rule: d of a glyph or missing-glyph is path data (SVG 1.1, §8.3.9, §20.4, §20.5). At line 2: <${element}> with d="L0 0".`,
                );

                expect(error.payload).to.deep.equal({
                    path: fontPath,
                    rule: FontRule.PathData,
                    element: element,
                    line: 2,
                    attribute: "d",
                    value: "L0 0",
                    valueLength: 4,
                });
            });
        }

        it("to a font without a font-face child", async function () {
            const message = "SVG font breaks a rule: font has a font-face child (SVG 1.1, §20.3). At line 2: <font>.";

            await expectAnswer(inline(`<font horiz-adv-x="500">${GLYPH}</font>`), BrokenFont, message);
            // Only a direct child counts.
            await expectAnswer(inline(`<font horiz-adv-x="500"><g>${FONT_FACE}</g>${GLYPH}</font>`), BrokenFont, message);
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
            // A missing-glyph is not a glyph, and only a direct child counts.
            await expectAnswer(inline(`<font horiz-adv-x="500">${FONT_FACE}<missing-glyph/></font>`), BrokenFont, message);
            await expectAnswer(inline(`<font horiz-adv-x="500">${FONT_FACE}<g>${GLYPH}</g></font>`), BrokenFont, message);
        });

        describe("to a kerning pair", function () {
            for (const element of ["hkern", "vkern"]) {
                it(`on ${element} without k`, async function () {
                    const error = await expectAnswer(
                        inline(kerned(`<${element} u1="a" u2="b"/>`)),
                        BrokenFont,
                        `SVG font breaks a rule: hkern and vkern have k (SVG 1.1, §20.7). At line 2: <${element}>.`,
                    );

                    expect(error.payload).to.deep.equal({ path: fontPath, rule: FontRule.KerningRequired, element: element, line: 2 });
                });

                it(`on ${element} whose k is not a number`, async function () {
                    // fontforge reads the number at the head of the value: 12garbage kerns by 12.
                    for (const value of ["12garbage", "nan", "", "5."]) {
                        const error = await expectAnswer(
                            inline(kerned(`<${element} u1="a" u2="b" k="${value}"/>`)),
                            BrokenFont,
                            `SVG font breaks a rule: a numeric attribute is a <number> (SVG 1.1, §4.2). At line 2: <${element}> with k=${JSON.stringify(
                                value,
                            )}.`,
                        );

                        expect(error.payload).to.include({ rule: FontRule.Number, element: element, attribute: "k", value: value });
                    }
                });
            }

            it("without one of its glyphs", async function () {
                const message =
                    "SVG font breaks a rule: hkern and vkern name both glyphs of the pair, by u1 or g1 and by u2 or g2 (SVG 1.1, §20.7). At line 2: <hkern>.";

                // A g1 of separators alone names no glyph: fontforge kerns nothing for it.
                for (const kernMarkup of [
                    '<hkern u2="b" k="50"/>',
                    '<hkern g1="a" k="50"/>',
                    '<hkern k="50"/>',
                    '<hkern g1="" u2="b" k="50"/>',
                    '<hkern g1=" , " u2="b" k="50"/>',
                ]) {
                    const error = await expectAnswer(inline(kerned(kernMarkup)), BrokenFont, message);

                    expect(error.payload).to.deep.equal({ path: fontPath, rule: FontRule.KernedGlyphRequired, element: "hkern", line: 2 });
                }

                await expectAnswer(inline(kerned('<vkern u1="a" k="50"/>')), BrokenFont, message.replace("<hkern>", "<vkern>"));
                await expectAnswer(
                    inline(kerned('<vkern u1="a" g2="&#9;,&#10;&#13; " k="50"/>')),
                    BrokenFont,
                    message.replace("<hkern>", "<vkern>"),
                );
            });

            it("whose u1 or u2 is not one character", async function () {
                const rule =
                    "u1 and u2 of hkern and vkern are one character each (ours: fontforge reads them as a string of characters, not the list of §20.7)";

                // fontforge kerns the comma of a list too, nothing for a range, and a and b for the ligature.
                for (const value of ["a,b", "U+0061-0062", "ab", ""]) {
                    const error = await expectAnswer(
                        inline(kerned(`<hkern u1="${value}" u2="b" k="50"/>`)),
                        BrokenFont,
                        `SVG font breaks a rule: ${rule}. At line 2: <hkern> with u1=${JSON.stringify(value)}.`,
                    );

                    expect(error.payload).to.include({ rule: FontRule.SingleKernedCharacter, attribute: "u1", value: value });
                }

                // A g2 next to it does not excuse u2.
                await expectAnswer(
                    inline(kerned('<vkern u1="a" u2="a,b" g2="b" k="50"/>')),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <vkern> with u2="a,b".`,
                );
            });

            it("only as a direct child of font", async function () {
                await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}${GLYPH}<g><hkern/></g>\n<hkern/></font>`),
                    BrokenFont,
                    "SVG font breaks a rule: hkern and vkern have k (SVG 1.1, §20.7). At line 3: <hkern>.",
                );
            });
        });

        describe("to a second font element", function () {
            const message =
                "SVG font breaks a rule: the document has one font element (ours: fontforge converts the first of several and drops the rest). At line 3: <font>.";

            it("next to a valid font, wherever it lies", async function () {
                await expectAnswer(inline(`${FONT}\n${FONT}`), BrokenFont, message);
                await expectAnswer(inline(`<defs>${FONT}</defs>\n<g><defs>${FONT}</defs></g>`), BrokenFont, message);
            });

            it("nested in a font, before the rule the outer font breaks at its close", async function () {
                // The outer font has no font-face, which is reported at its end tag, after the inner start tag.
                await expectAnswer(inline(`<font horiz-adv-x="500">${GLYPH}\n${FONT}</font>`), BrokenFont, message);
            });

            it("before the rules of that font", async function () {
                await expectAnswer(inline(`${FONT}\n<font horiz-adv-x="-1">${FONT_FACE}${GLYPH}</font>`), BrokenFont, message);
            });
        });

        describe("to a font node name outside the SVG namespace", function () {
            const rule =
                "the name of a font node is given only to an element in the SVG namespace (ours: fontforge reads a node of that name in any namespace, and a processing instruction by its target)";

            for (const name of ["font", "font-face", "glyph", "missing-glyph", "hkern", "vkern"]) {
                it(`on a ${name} element, quoted in Clark notation`, async function () {
                    const error = await expectAnswer(
                        inline(`<font horiz-adv-x="500">${FONT_FACE}${GLYPH}\n<x:${name} xmlns:x="urn:x"/></font>`),
                        BrokenFont,
                        `SVG font breaks a rule: ${rule}. At line 3: <{urn:x}${name}>.`,
                    );

                    expect(error.payload).to.deep.equal({
                        path: fontPath,
                        rule: FontRule.SvgNamespaceOnly,
                        element: `{urn:x}${name}`,
                        line: 3,
                    });
                });

                it(`on a processing instruction whose target is ${name}`, async function () {
                    const error = await expectAnswer(
                        inline(`${FONT}\n<?${name} id="Ghost"?>`),
                        BrokenFont,
                        `SVG font breaks a rule: ${rule}. At line 3: <?${name}?>.`,
                    );

                    expect(error.payload).to.deep.equal({ path: fontPath, rule: FontRule.SvgNamespaceOnly, element: `?${name}?`, line: 3 });
                });
            }

            it("on an element in no namespace, wherever it lies", async function () {
                await expectAnswer(
                    inline(`<g xmlns="">\n<glyph/></g>${FONT}`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 3: <{}glyph>.`,
                );
            });

            it("on a font in the default namespace, not quoted as an SVG font", async function () {
                await expectAnswer(
                    inline(`<font xmlns="urn:x"/>\n${FONT}`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <{urn:x}font>.`,
                );
            });

            it("before the rules of the font it lies in", async function () {
                // fontforge converts this font from the foreign glyph, while it has no glyph of the SVG namespace.
                await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}\n<x:glyph xmlns:x="urn:x" d="M0 0L100 0L100 100Z"/></font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 3: <{urn:x}glyph>.`,
                );
            });

            it("naming the line a processing instruction closes on", async function () {
                // saxes reports a processing instruction at its `?>`.
                await expectAnswer(
                    inline(`<?font\nid="Ghost"?>${FONT}`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 3: <?font?>.`,
                );
            });

            it("quoting the namespace cut to 64 UTF-16 units", async function () {
                const error = await expectAnswer(
                    inline(`${FONT}\n<x:glyph xmlns:x="urn:${"a".repeat(100)}"/>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 3: <{urn:${"a".repeat(60)}…}glyph>.`,
                );

                expect(error.payload).to.include({ element: `{urn:${"a".repeat(60)}…}glyph` });
            });

            it("quoting the namespace escaped in the message and unescaped in the payload", async function () {
                const error = await expectAnswer(
                    inline(`${FONT}\n<x:glyph xmlns:x="urn:a&#10;b"/>`),
                    BrokenFont,
                    String.raw`SVG font breaks a rule: ${rule}. At line 3: <{urn:a\nb}glyph>.`,
                );

                expect(error.payload).to.include({ element: "{urn:a\nb}glyph" });
            });
        });

        describe("to a prefixed attribute of a font node", function () {
            const rule =
                "a font node has no prefixed attribute (ours: fontforge reads the first attribute of a local name, in any namespace)";

            it("before a valid unprefixed one", async function () {
                // fontforge takes the garbage outline here and loops on it.
                const error = await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph xmlns:x="urn:x" x:d="garbage" d="M0 0"/></font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <glyph> with x:d="garbage".`,
                );

                expect(error.payload).to.deep.equal({
                    path: fontPath,
                    rule: FontRule.UnprefixedAttribute,
                    element: "glyph",
                    line: 2,
                    attribute: "x:d",
                    value: "garbage",
                    valueLength: 7,
                });
            });

            it("of a name no rule reads", async function () {
                // fontforge maps this glyph to "b".
                await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph xmlns:x="urn:x" x:unicode="b" unicode="a"/></font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <glyph> with x:unicode="b".`,
                );
                await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph xml:lang="en"/></font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <glyph> with xml:lang="en".`,
                );
            });

            it("on font, font-face, missing-glyph, hkern and vkern", async function () {
                await expectAnswer(
                    inline(`<font horiz-adv-x="500" xmlns:x="urn:x" x:horiz-adv-x="-1">${FONT_FACE}${GLYPH}</font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <font> with x:horiz-adv-x="-1".`,
                );
                await expectAnswer(
                    inline(`<font horiz-adv-x="500"><font-face xmlns:x="urn:x" x:units-per-em="0" units-per-em="1000"/>${GLYPH}</font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <font-face> with x:units-per-em="0".`,
                );
                await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}<missing-glyph xmlns:x="urn:x" x:vert-adv-y="1"/>${GLYPH}</font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <missing-glyph> with x:vert-adv-y="1".`,
                );
                // fontforge kerns this pair by 70.
                await expectAnswer(
                    inline(kerned('<hkern xmlns:x="urn:x" u1="a" u2="b" x:k="70" k="50"/>')),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <hkern> with x:k="70".`,
                );
                await expectAnswer(
                    inline(kerned('<vkern xmlns:x="urn:x" x:u1="b" u1="a" u2="b" k="50"/>')),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <vkern> with x:u1="b".`,
                );
            });

            it("before the other rules of that node", async function () {
                await expectAnswer(
                    inline(`<font horiz-adv-x="-1" xmlns:x="urn:x" x:label="a">${FONT_FACE}${GLYPH}</font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <font> with x:label="a".`,
                );
            });

            it("quoting the prefix and the local name of its name each cut to 64 UTF-16 units", async function () {
                // A long prefix must not cut off the local name.
                const prefix = "p".repeat(70);
                const local = "l".repeat(70);
                const cases: Array<[string, string]> = [
                    [`${prefix}:d`, `${"p".repeat(64)}…:d`],
                    [`x:${local}`, `x:${"l".repeat(64)}…`],
                    [`${prefix}:${local}`, `${"p".repeat(64)}…:${"l".repeat(64)}…`],
                ];

                for (const [name, quoted] of cases) {
                    const namespacePrefix = name.slice(0, name.indexOf(":"));
                    const error = await expectAnswer(
                        inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph xmlns:${namespacePrefix}="urn:x" ${name}="M0 0"/></font>`),
                        BrokenFont,
                        `SVG font breaks a rule: ${rule}. At line 2: <glyph> with ${quoted}="M0 0".`,
                    );

                    expect(error.payload).to.include({ attribute: quoted });
                }
            });
        });

        describe("to a child element of a glyph", function () {
            const rule =
                "glyph and missing-glyph have no child elements or processing instructions (ours: fontforge draws a glyph without d from its children as any SVG, and drops them next to d)";

            it("drawing a glyph without d", async function () {
                // fontforge dies on this outline with a segmentation fault.
                const error = await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph unicode="a">\n<path d="garbage"/></glyph></font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 3: <path>.`,
                );

                expect(error.payload).to.deep.equal({ path: fontPath, rule: FontRule.ChildlessGlyph, element: "path", line: 3 });
            });

            it("next to d, of missing-glyph, and outside the SVG namespace", async function () {
                await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph d="M0 0"><title>a</title></glyph></font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <title>.`,
                );
                await expectAnswer(
                    inline(
                        `<font horiz-adv-x="500">${FONT_FACE}<missing-glyph><rect width="1" height="1"/></missing-glyph>${GLYPH}</font>`,
                    ),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <rect>.`,
                );
                await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph><x:path xmlns:x="urn:x" d="M0 0"/></glyph></font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <{urn:x}path>.`,
                );
            });

            it("on a processing instruction, quoted by its target", async function () {
                // libxml2 names the instruction by its target, the name fontforge dispatches a child on.
                const error = await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph unicode="a"><?path d="garbage"?></glyph></font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <?path?>.`,
                );

                expect(error.payload).to.deep.equal({ path: fontPath, rule: FontRule.ChildlessGlyph, element: "?path?", line: 2 });
                await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph><?${"t".repeat(70)}?></glyph></font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <?${"t".repeat(64)}…?>.`,
                );
            });

            it("quoting its local name cut to 64 UTF-16 units", async function () {
                const error = await expectAnswer(
                    inline(`<font horiz-adv-x="500">${FONT_FACE}<glyph><${"c".repeat(70)}/></glyph></font>`),
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 2: <${"c".repeat(64)}…>.`,
                );

                expect(error.payload).to.include({ element: `${"c".repeat(64)}…` });
            });
        });

        describe("to a DOCTYPE with an internal subset", function () {
            const rule =
                "the DOCTYPE has no internal subset (ours: fontforge takes attribute defaults from it, which the validator does not read)";

            it("declaring an attribute default", async function () {
                // fontforge takes the default d of the glyph and loops on it.
                const error = await expectAnswer(
                    `<!DOCTYPE svg [\n<!ATTLIST glyph d CDATA "garbage">\n]>\n${inline(FONT)}`,
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 3: <!DOCTYPE>.`,
                );

                expect(error.payload).to.deep.equal({ path: fontPath, rule: FontRule.NoInternalSubset, element: "!DOCTYPE", line: 3 });
            });

            it("followed by text saxes lets through", async function () {
                // saxes accepts text between the subset and `>`, so the end of the DOCTYPE is no sign of a subset.
                await expectAnswer(
                    `<!DOCTYPE svg [<!ATTLIST glyph d CDATA "garbage">] x>${inline(FONT)}`,
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 1: <!DOCTYPE>.`,
                );
            });

            it("empty, and after the SVG 1.1 external ID", async function () {
                await expectAnswer(
                    `<!DOCTYPE svg [ ] >${inline(FONT)}`,
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 1: <!DOCTYPE>.`,
                );
                await expectAnswer(
                    `${SVG11_DOCTYPE.replace(/>$/, " []>")}<svg>${FONT}</svg>`,
                    BrokenFont,
                    `SVG font breaks a rule: ${rule}. At line 1: <!DOCTYPE>.`,
                );
            });
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
        await expectRejection(() => validator.validate(path.join(workDir, `missing.${Extension.SVG}`)), ReadFailed);
    });

    async function validate(content: string | Uint8Array): Promise<void> {
        await fs.writeFile(fontPath, content);
        await validator.validate(fontPath);
    }

    /**
     * Checks, besides the class and the message, that the answer names the rejected file, as every
     * answer of the validator does.
     */
    async function expectAnswer<T extends InvalidSvgFont>(
        content: string | Uint8Array,
        expected: new (...params: never) => T,
        message?: string,
    ): Promise<T> {
        const error = await expectRejection(() => validate(content), expected, message);

        expect(error.payload).to.include({ path: fontPath });

        return error;
    }
});

async function expectRejection<T extends Error>(
    call: () => Promise<void>,
    expected: new (...params: never) => T,
    message?: string,
): Promise<T> {
    try {
        await call();
    } catch (error) {
        expect(error).to.be.instanceOf(expected);

        if (message !== undefined) {
            expect((error as T).message).to.equal(message);
        }

        return error as T;
    }

    return expect.fail(`the call did not throw ${expected.name}`);
}

function concat(...parts: Array<Uint8Array | Array<number>>): Uint8Array {
    return Buffer.concat(parts.map((part) => Uint8Array.from(part)));
}

function utf16le(text: string): Uint8Array {
    return concat([0xff, 0xfe], Buffer.from(text, "utf16le"));
}

function utf16be(text: string): Uint8Array {
    return concat([0xfe, 0xff], Buffer.from(text, "utf16le").swap16());
}
