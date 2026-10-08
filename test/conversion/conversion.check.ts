import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { Extension } from "app/font-convertor/font-convertor.types";
import { expectedDifferences } from "test/conversion/expected-differences";
import { FontFactsComparator } from "test/conversion/font-facts-comparator";
import { FontFactsReader } from "test/conversion/font-facts-reader";
import { FONT_FORGE_PATH, realConvertorFactory, realFontValidatorResolver } from "test/font-convertor/convertor-factory.helper";

const COMPRESSED_EOT_FIXTURE_NAME = "test-font-compressed.eot";
const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// The conversion check (docs/architecture/testing.md, "The conversion check"): every pair of the pair
// table converts its fixture with the real engine and codec, the route the bot takes, and the facts of
// the result are compared with those of the source changed by the expected differences of the pair.
describe("Conversion of the fixtures", function () {
    const factory = realConvertorFactory(realFontValidatorResolver());
    const reader = new FontFactsReader(new EotPacker(new EotPayloadDecoder()), FONT_FORGE_PATH);
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
            const pairDifferences = expectedDifferences.filter(
                (expected) => expected.fromExtensions.includes(fromExtension) && expected.toExtensions.includes(toExtension),
            );

            for (const fixtureName of fixtureNamesOf(fromExtension)) {
                it(`converts ${fixtureName} to ${toExtension} changing only the expected facts`, async function () {
                    const sourcePath = path.join(fixtureDir, fixtureName);
                    const resultPath = path.join(workDir, `result.${toExtension}`);

                    await factory.get(fromExtension, toExtension).convert(sourcePath, resultPath);

                    let expectedFacts = await reader.read(sourcePath, workDir);

                    for (const expected of pairDifferences) {
                        expectedFacts = expected.resultFacts(expectedFacts);
                    }

                    const differences = comparator.compare(expectedFacts, await reader.read(resultPath, workDir));
                    expect(differences, JSON.stringify(differences)).to.be.empty;
                });
            }
        }
    }

    // Without this an entry with a pair the table does not have, a typo or a pair dropped from it,
    // would wait in the list unnoticed: the loop above looks entries up by the pairs that run.
    it("lists expected differences only for pairs of the pair table", function () {
        for (const expected of expectedDifferences) {
            for (const fromExtension of expected.fromExtensions) {
                for (const toExtension of expected.toExtensions) {
                    expect(fromExtension, expected.reason).not.to.equal(toExtension);
                    expect(() => factory.get(fromExtension, toExtension), expected.reason).not.to.throw();
                }
            }
        }
    });

    // The compressed EOT goes the whole way as a source of its own: the codec decodes MicroType
    // Express on unpacking, and the engine converts what it decodes.
    function fixtureNamesOf(extension: Extension): Array<string> {
        if (extension === Extension.EOT) {
            return [`test-font.${Extension.EOT}`, COMPRESSED_EOT_FIXTURE_NAME];
        }

        return [`test-font.${extension}`];
    }
});
