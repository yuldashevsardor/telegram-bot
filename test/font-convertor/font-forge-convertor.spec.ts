import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import { WoffFontValidator } from "app/font-convertor/validator/woff/woff-font-validator";
import { Woff2FontValidator } from "app/font-convertor/validator/woff2/woff2-font-validator";
import { EotFontValidator } from "app/font-convertor/validator/eot/eot-font-validator";
import { InvalidPath } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// The pairs without EOT run on the real fontforge from the image. Such a pair has no logic of its
// own beyond the input check and the engine call. A stub engine would confirm only the call, not
// that the pair is reachable. Each pair calls the check itself, so a rejection is pinned for each.
// The branches of the check itself run in convertor.spec.ts. The EOT pairs run on stubs in
// eot-convertor.spec.ts; only two of their routes run here, with the real engine and codec, below:
// eot → svg and the compressed eot → woff.
describe("Convertors of the engine pairs", function () {
    const resolver = new FontValidatorResolver(
        new SvgFontValidator(),
        new WoffFontValidator(new SfntFontValidator()),
        new Woff2FontValidator(),
        new SfntFontValidator(),
        new EotFontValidator(new SfntFontValidator(), new EotPayloadDecoder()),
    );
    const factory = new ConvertorFactory(new FontForge("fontforge"), resolver, new EotPacker(new EotPayloadDecoder()));
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

    // The sfnt MicroType Express rebuilds goes the whole way of a pair from EOT: the validator and the
    // codec decode the compressed fixture, and the engine converts what they decode.
    it("converts a compressed eot to a woff WoffFontValidator accepts", async function () {
        const toPath = path.join(workDir, `result.${Extension.WOFF}`);

        await factory.get(Extension.EOT, Extension.WOFF).convert(path.join(fixtureDir, "test-font-compressed.eot"), toPath);

        await resolver.get(Extension.WOFF).validate(toPath);
    });

    // Some of the classes of source the validator admits beyond the fixture, each made from the
    // fixture. If the engine failed on one, the domain would accept a source and then fail in the
    // engine.
    const svgNamespaceDeclaration = 'xmlns="http://www.w3.org/2000/svg"';
    const svgDoctype = /<!DOCTYPE[^>]*>\s*/;
    const xmlDeclarationLine = /^<\?xml [^>]*>\n/;
    // The prologues of #196: a comment or a processing instruction may open a document without an
    // XML declaration, a processing instruction also after an indent and with any target.
    const prologues = ["<!-- editor -->", '\n<?xml-stylesheet href="a.css"?>', "<?sodipodi-namespace?>", "  <?xmlfoo bar?>"];
    const svgSources: Array<{ name: string; fromFixture: (fixtureText: string) => Uint8Array }> = [
        { name: "with a UTF-8 BOM", fromFixture: (fixtureText) => Buffer.from("\uFEFF" + fixtureText) },
        { name: "in UTF-16LE with a BOM", fromFixture: (fixtureText) => Buffer.from("\uFEFF" + fixtureText, "utf16le") },
        { name: "in UTF-16BE with a BOM", fromFixture: (fixtureText) => Buffer.from("\uFEFF" + fixtureText, "utf16le").swap16() },
        {
            name: "with the SVG namespace under a prefix and no DOCTYPE",
            fromFixture: (fixtureText): Uint8Array => {
                expect(fixtureText, "the svg fixture does not declare the default namespace").to.include(svgNamespaceDeclaration);
                expect(fixtureText, "the svg fixture has no DOCTYPE").to.match(svgDoctype);
                // Every start and end tag gets the prefix; `<?` and `<!` do not open a tag. Without
                // the DOCTYPE only the declaration binds the prefix.
                const prefixedText = fixtureText
                    .replace(svgDoctype, "")
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
        { name: "without the XML declaration", fromFixture: (fixtureText) => Buffer.from(withoutDeclaration(fixtureText)) },
        ...prologues.map((prologue) => ({
            name: `opening with ${JSON.stringify(prologue)}`,
            fromFixture: (fixtureText: string) => Buffer.from(prologue + withoutDeclaration(fixtureText)),
        })),
    ];

    const sourceModifiedAt = new Date("2020-01-01T00:00:00Z");

    for (const svgSource of svgSources) {
        it(`converts svg ${svgSource.name} into the font the fixture converts into`, async function () {
            const fixtureText = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.SVG}`), "utf8");
            const fixturePath = path.join(workDir, `fixture.${Extension.SVG}`);
            const fromPath = path.join(workDir, `source.${Extension.SVG}`);
            const toPath = path.join(workDir, `result.${Extension.TTF}`);
            const fixtureResultPath = path.join(workDir, `fixture-result.${Extension.TTF}`);
            await fs.writeFile(fixturePath, fixtureText);
            await fs.writeFile(fromPath, svgSource.fromFixture(fixtureText));
            // The engine stamps the result with the modification time of the source, in whole
            // seconds. With one time on both sources the result has to repeat the fixture's byte
            // for byte. The time is set, not copied from the checkout: a Date copied from a stat
            // rounds to the millisecond and can move into the next second.
            await fs.utimes(fixturePath, sourceModifiedAt, sourceModifiedAt);
            await fs.utimes(fromPath, sourceModifiedAt, sourceModifiedAt);

            await factory.get(Extension.SVG, Extension.TTF).convert(fromPath, toPath);

            await factory.get(Extension.SVG, Extension.TTF).convert(fixturePath, fixtureResultPath);
            expect(await fs.readFile(toPath)).to.deep.equal(await fs.readFile(fixtureResultPath));
        });

        // Every pair from SVG, EOT included, checks the source itself, so each has to take it. The
        // result is checked by the validator of its format.
        for (const toExtension of nonSvgExtensions) {
            it(`converts svg ${svgSource.name} to ${toExtension}`, async function () {
                const fixtureText = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.SVG}`), "utf8");
                const fromPath = path.join(workDir, `source.${Extension.SVG}`);
                const toPath = path.join(workDir, `result.${toExtension}`);
                await fs.writeFile(fromPath, svgSource.fromFixture(fixtureText));

                await factory.get(Extension.SVG, toExtension).convert(fromPath, toPath);

                await resolver.get(toExtension).validate(toPath);
            });
        }
    }

    function withoutDeclaration(fixtureText: string): string {
        expect(fixtureText, "the svg fixture does not open with the XML declaration").to.match(xmlDeclarationLine);

        return fixtureText.replace(xmlDeclarationLine, "");
    }

    function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
        return call().then(
            () => expect.fail("call did not throw"),
            (error: unknown) => error,
        );
    }
});
