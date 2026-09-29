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

// The pairs without EOT run on the real fontforge from the image. Such a pair has no logic of its
// own beyond the input check and the engine call. A stub engine would confirm only the call, not
// that the pair is reachable. Each pair calls the check itself, so a rejection is pinned for each.
// The branches of the check itself run in convertor.spec.ts.
describe("Convertors of the engine pairs", function () {
    const resolver = new FontValidatorResolver(new FontSignatureMatcher(), new SvgFontValidator());
    const factory = new ConvertorFactory(new FontForge("fontforge"), resolver, new EotPacker());
    const engineExtensions = factory.getSupportedExtensions().filter((extension) => extension !== Extension.EOT);
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

    // A processing instruction may open a document without an XML declaration, after an indent and
    // with any target, and the engine converts every one of these: the validator has to admit them.
    for (const prologue of ['\n<?xml-stylesheet href="a.css"?>', "<?sodipodi-namespace?>", "  <?xmlfoo bar?>"]) {
        it(`converts svg opening with ${JSON.stringify(prologue)}`, async function () {
            const fixtureText = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.SVG}`), "utf8");
            // The XML declaration has to open the document, so it gives way to the prologue.
            expect(fixtureText, "the svg fixture does not open with the XML declaration").to.match(/^<\?xml /);
            const fixtureBody = fixtureText.slice(fixtureText.indexOf("?>") + "?>".length);
            const fromPath = path.join(workDir, `source.${Extension.SVG}`);
            const toPath = path.join(workDir, `result.${Extension.WOFF}`);
            await fs.writeFile(fromPath, prologue + fixtureBody);

            await factory.get(Extension.SVG, Extension.WOFF).convert(fromPath, toPath);

            await resolver.get(Extension.WOFF).validate(toPath);
        });
    }

    // The classes of source the validator admits beyond the fixture, each made from the fixture. If
    // the engine failed on one, the domain would accept a source and then fail in the engine.
    const svgNamespaceDeclaration = 'xmlns="http://www.w3.org/2000/svg"';
    const svgSources: Array<{ name: string; fromFixture: (fixtureText: string) => Uint8Array }> = [
        { name: "in UTF-16LE with a BOM", fromFixture: (fixtureText) => Buffer.from("﻿" + fixtureText, "utf16le") },
        { name: "in UTF-16BE with a BOM", fromFixture: (fixtureText) => Buffer.from("﻿" + fixtureText, "utf16le").swap16() },
        {
            name: "with the SVG namespace under a prefix",
            fromFixture: (fixtureText): Uint8Array => {
                expect(fixtureText, "the svg fixture does not declare the default namespace").to.include(svgNamespaceDeclaration);
                // Every start and end tag gets the prefix; `<?` and `<!` do not open a tag.
                const prefixedText = fixtureText
                    .replace(/<(\/?)(?=[A-Za-z])/g, "<$1s:")
                    .replace(svgNamespaceDeclaration, 'xmlns:s="http://www.w3.org/2000/svg"');

                return Buffer.from(prefixedText);
            },
        },
        {
            name: "without xmlns under the SVG 1.1 DOCTYPE",
            fromFixture: (fixtureText): Uint8Array => {
                expect(fixtureText, "the svg fixture has no SVG 1.1 DOCTYPE").to.include('"-//W3C//DTD SVG 1.1//EN"');
                // As in Font Awesome 4.7: the root declares no namespace at all.
                const unboundText = fixtureText.replace(/ xmlns(:xlink)?="[^"]*"/g, "");
                expect(unboundText, "a namespace declaration is left in the svg fixture").not.to.include("xmlns");

                return Buffer.from(unboundText);
            },
        },
    ];

    for (const svgSource of svgSources) {
        it(`converts svg ${svgSource.name} with every glyph of the fixture`, async function () {
            const fixturePath = path.join(fixtureDir, `test-font.${Extension.SVG}`);
            const fromPath = path.join(workDir, `source.${Extension.SVG}`);
            const toPath = path.join(workDir, `result.${Extension.TTF}`);
            const fixtureResultPath = path.join(workDir, `fixture-result.${Extension.TTF}`);
            await fs.writeFile(fromPath, svgSource.fromFixture(await fs.readFile(fixturePath, "utf8")));

            await factory.get(Extension.SVG, Extension.TTF).convert(fromPath, toPath);

            await resolver.get(Extension.TTF).validate(toPath);
            // The engine stamps the result with the modification time of the source, so its bytes
            // differ from those of the fixture's result. The size does not, while a font that lost
            // glyphs on the way would be smaller.
            await factory.get(Extension.SVG, Extension.TTF).convert(fixturePath, fixtureResultPath);
            expect((await fs.stat(toPath)).size).to.equal((await fs.stat(fixtureResultPath)).size);
        });
    }

    function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
        return call().then(
            () => expect.fail("call did not throw"),
            (error: unknown) => error,
        );
    }
});
