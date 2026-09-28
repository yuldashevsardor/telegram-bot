import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import { SvgFontValidator } from "app/font-convertor/svg-validator/svg-font-validator";
import { FileHelper } from "app/shared/fs/file-helper";
import { InvalidPath } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// The pairs without EOT run on the real fontforge from the image. Such a pair has no logic of its
// own beyond the input check and the engine call. A stub engine would confirm only the call, not
// that the pair is reachable. Each pair calls the check itself, so a rejection is pinned for each.
// The branches of the check itself run in convertor.spec.ts.
describe("Convertors of the engine pairs", function () {
    const matcher = new FontSignatureMatcher();
    const validator = new SvgFontValidator();
    const factory = new ConvertorFactory(new FontForge("fontforge"), matcher, validator, new EotPacker());
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

                await expectFormat(toPath, toExtension);
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

            await expectFormat(toPath, Extension.WOFF);
        });
    }

    // SVG has no signature, so an SVG result is checked by the validator.
    async function expectFormat(filePath: string, extension: Extension): Promise<void> {
        if (extension === Extension.SVG) {
            await validator.validate(filePath);

            return;
        }

        const head = await FileHelper.readHead(filePath, matcher.headLength);
        expect(matcher.matches(head, extension), "the result is not in the target format").to.be.true;
    }

    function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
        return call().then(
            () => expect.fail("call did not throw"),
            (error: unknown) => error,
        );
    }
});
