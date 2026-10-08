import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { EotFontValidator } from "app/font-convertor/validator/eot/eot-font-validator";
import { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import { WoffFontValidator } from "app/font-convertor/validator/woff/woff-font-validator";
import { Woff2FontValidator } from "app/font-convertor/validator/woff2/woff2-font-validator";
import { expectedDifferences } from "test/conversion/expected-differences";
import { FontFactsComparator } from "test/conversion/font-facts-comparator";
import { FontFactsReader } from "test/conversion/font-facts-reader";

const FONT_FORGE_PATH = "fontforge";
const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// The conversion check (docs/architecture/testing.md, "The conversion check"): every pair of the pair
// table converts its fixture with the real engine and codec, the route the bot takes, and the facts of
// the result are compared with those of the source.
describe("Conversion of the fixtures", function () {
    const eotPacker = new EotPacker(new EotPayloadDecoder());
    const factory = new ConvertorFactory(
        new FontForge(FONT_FORGE_PATH),
        new FontValidatorResolver(
            new SvgFontValidator(),
            new WoffFontValidator(new SfntFontValidator()),
            new Woff2FontValidator(new SfntFontValidator()),
            new SfntFontValidator(),
            new EotFontValidator(new SfntFontValidator(), new EotPayloadDecoder()),
        ),
        eotPacker,
    );
    const reader = new FontFactsReader(eotPacker, FONT_FORGE_PATH);
    const comparator = new FontFactsComparator();
    const extensions = factory.getSupportedExtensions();
    let workDir: string;

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "conversion-check-"));
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    for (const fromExtension of extensions) {
        for (const toExtension of extensions.filter((extension) => extension !== fromExtension)) {
            const expectedFacts = expectedDifferences
                .filter((expected) => expected.fromExtensions.includes(fromExtension) && expected.toExtensions.includes(toExtension))
                .flatMap((expected) => expected.facts);

            it(`converts ${fromExtension} to ${toExtension} changing only the expected facts`, async function () {
                const sourcePath = path.join(fixtureDir, `test-font.${fromExtension}`);
                const resultPath = path.join(workDir, `result.${toExtension}`);

                await factory.get(fromExtension, toExtension).convert(sourcePath, resultPath);

                const differences = comparator.compare(await reader.read(sourcePath, workDir), await reader.read(resultPath, workDir));
                const differentFacts = differences.map((difference) => difference.fact);
                expect(differentFacts, JSON.stringify(differences)).to.have.same.members(expectedFacts);
            });
        }
    }
});
