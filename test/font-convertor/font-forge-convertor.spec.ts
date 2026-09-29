import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import { InvalidPath } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

const UTF8_BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Uint8Array.from([0xff, 0xfe]);
const UTF16BE_BOM = Uint8Array.from([0xfe, 0xff]);
const XML_DECLARATION_LINE = /^<\?xml [^>]*>\n/;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SVG_XMLNS = ` xmlns="${SVG_NAMESPACE}"`;

// The pairs without EOT run on the real fontforge from the image. Such a pair has no logic of its
// own beyond the input check and the engine call. A stub engine would confirm only the call, not
// that the pair is reachable. Each pair calls the check itself, so a rejection is pinned for each.
// The branches of the check itself run in convertor.spec.ts. The EOT pairs run on stubs in
// eot-convertor.spec.ts; only their SVG route runs here, with the real engine and codec, below.
describe("Convertors of the engine pairs", function () {
    const resolver = new FontValidatorResolver(new FontSignatureMatcher(), new SvgFontValidator());
    const factory = new ConvertorFactory(new FontForge("fontforge"), resolver, new EotPacker());
    const engineExtensions = factory.getSupportedExtensions().filter((extension) => extension !== Extension.EOT);
    const nonSvgExtensions = factory.getSupportedExtensions().filter((extension) => extension !== Extension.SVG);
    let workDir: string;

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "font-forge-convertor-"));
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    for (const fromExtension of engineExtensions) {
        for (const toExtension of engineExtensions.filter((extension) => extension !== fromExtension)) {
            it(`converts ${fromExtension} to ${toExtension}`, async function () {
                const toPath = path.join(workDir, `result.${toExtension}`);

                await factory.get(fromExtension, toExtension).convert(path.join(fixtureDir, `test-font.${fromExtension}`), toPath);

                // The result is checked by the validator a source of its format meets.
                await resolver.get(toExtension).validate(toPath);
            });

            it(`refuses to write ${fromExtension} to ${toExtension} over an existing file`, async function () {
                const toPath = path.join(workDir, `result.${toExtension}`);
                const existing = Uint8Array.from([0]);
                await fs.writeFile(toPath, existing);

                const error = await rejectionOf(() =>
                    factory.get(fromExtension, toExtension).convert(path.join(fixtureDir, `test-font.${fromExtension}`), toPath),
                );

                expect(error).to.be.instanceOf(InvalidPath);
                expect((error as InvalidPath).message).to.equal(InvalidPath.isAlreadyExists(toPath).message);
                expect(await fs.readFile(toPath), "the engine wrote over an existing file").to.deep.equal(Buffer.from(existing));
            });
        }
    }

    // The loop above checks by SvgFontValidator the svg written from every other fixture but EOT.
    it("writes from eot an svg SvgFontValidator accepts", async function () {
        const toPath = path.join(workDir, `result.${Extension.SVG}`);

        await factory.get(Extension.EOT, Extension.SVG).convert(path.join(fixtureDir, `test-font.${Extension.EOT}`), toPath);

        await resolver.get(Extension.SVG).validate(toPath);
    });

    // The validator decides which SVG files are fonts, and the engine has to convert every one it
    // admits. The variants of the fixture are the ones the validator spec accepts, built the same way.
    describe("converts an svg SvgFontValidator accepts", function () {
        let fixtureText: string;

        before(async function () {
            fixtureText = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.SVG}`), "utf8");
            // Without these a variant that removes them would be the fixture itself.
            expect(fixtureText, "the svg fixture does not open with the XML declaration").to.match(XML_DECLARATION_LINE);
            expect(fixtureText, "the svg fixture has no xmlns").to.include(SVG_XMLNS);
        });

        // The prologues of #196: a comment or a processing instruction may open a document without
        // an XML declaration, a processing instruction also after an indent and with any target.
        const prologues = ["<!-- editor -->", '\n<?xml-stylesheet href="a.css"?>', "<?sodipodi-namespace?>", "  <?xmlfoo bar?>"];
        const variants: Array<{ description: string; build: (text: string) => string | Uint8Array }> = [
            { description: "with a UTF-8 BOM", build: (text) => Buffer.concat([UTF8_BOM, Buffer.from(text, "utf8")]) },
            { description: "in UTF-16LE with a BOM", build: (text) => Buffer.concat([UTF16LE_BOM, Buffer.from(text, "utf16le")]) },
            {
                description: "in UTF-16BE with a BOM",
                build: (text) => Buffer.concat([UTF16BE_BOM, Buffer.from(text, "utf16le").swap16()]),
            },
            { description: "without the XML declaration", build: withoutDeclaration },
            ...prologues.map((prologue) => ({
                description: `opening with ${JSON.stringify(prologue)}`,
                build: (text: string) => prologue + withoutDeclaration(text),
            })),
            { description: "in the SVG namespace bound to a prefix", build: withNamespacePrefix },
            // The SVG 1.1 DTD fixes xmlns of svg to the SVG namespace.
            { description: "without xmlns under the SVG 1.1 DOCTYPE", build: (text) => text.replace(SVG_XMLNS, "") },
        ];

        for (const variant of variants) {
            for (const toExtension of nonSvgExtensions) {
                it(`${variant.description} to ${toExtension}`, async function () {
                    const fromPath = path.join(workDir, `source.${Extension.SVG}`);
                    const toPath = path.join(workDir, `result.${toExtension}`);
                    await fs.writeFile(fromPath, variant.build(fixtureText));

                    await factory.get(Extension.SVG, toExtension).convert(fromPath, toPath);

                    await resolver.get(toExtension).validate(toPath);
                });
            }
        }
    });

    function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
        return call().then(
            () => expect.fail("call did not throw"),
            (error: unknown) => error,
        );
    }
});

function withoutDeclaration(fixtureText: string): string {
    return fixtureText.replace(XML_DECLARATION_LINE, "");
}

// Every element of the fixture moves into the prefix s. An opening "<" is followed by a name only in
// a tag: the DOCTYPE and the XML declaration open with "<!" and "<?", and no text holds a "<".
function withNamespacePrefix(fixtureText: string): string {
    return fixtureText.replace(/<(\/?)(?=[a-z])/g, "<$1s:").replace(SVG_XMLNS, ` xmlns:s="${SVG_NAMESPACE}"`);
}
