import { expect } from "chai";
import { readdirSync } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import type { Extension } from "app/font-convertor/font-convertor.types";
import { expectedDifferences, sourceFixtureRelativePaths } from "test/conversion/expected-differences";
import { FontFactsComparator } from "test/conversion/font-facts-comparator";
import { FontFactsReader } from "test/conversion/font-facts-reader";
import { FONT_FORGE_PATH, realConvertorFactory, realFontValidatorResolver } from "test/font-convertor/convertor-factory.helper";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
// The default timeout of mocha, 2 s, is too close: a case runs fontforge up to three times, the slowest
// corpus case, Inter into woff2, took about 1.5 s under a load average of 25, and parallel sessions slow
// one another down 3–8× (docs/agents/review-gates.md).
const CASE_TIMEOUT_MS = 20 * 1000;

// A font of the fixture directory, by its path relative to it.
type FontFixture = { relativePath: string; extension: Extension };

// The conversion check (docs/architecture/testing.md, "The conversion check"): every font fixture is
// converted into every format the pair table takes it to, with the real engine and codec, the route the
// bot takes, and the facts of the result are compared with those of the source changed by the expected
// differences of the fixture and pair.
describe("Conversion of the fixtures", function () {
    this.timeout(CASE_TIMEOUT_MS);

    const factory = realConvertorFactory(realFontValidatorResolver());
    const reader = new FontFactsReader(new EotPacker(new EotPayloadDecoder()), FONT_FORGE_PATH);
    const comparator = new FontFactsComparator();
    const extensions = factory.getSupportedExtensions();
    const fontFixtures = readFontFixtures();
    let workDir: string;

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "conversion-check-"));
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    for (const fixture of fontFixtures) {
        for (const toExtension of extensions.filter((extension) => extension !== fixture.extension)) {
            const pairDifferences = expectedDifferences.filter(
                (expected) => expected.fixtureRelativePaths.includes(fixture.relativePath) && expected.toExtensions.includes(toExtension),
            );

            it(`converts ${fixture.relativePath} to ${toExtension} changing only the expected facts`, async function () {
                const sourcePath = path.join(fixtureDir, fixture.relativePath);
                const resultPath = path.join(workDir, `result.${toExtension}`);

                await factory.get(fixture.extension, toExtension).convert(sourcePath, resultPath);

                let expectedFacts = await reader.read(sourcePath, workDir);

                for (const expected of pairDifferences) {
                    expectedFacts = expected.resultFacts(expectedFacts);
                }

                const differences = comparator.compare(expectedFacts, await reader.read(resultPath, workDir));
                expect(differences, JSON.stringify(differences)).to.be.empty;
            });
        }
    }

    // The fixtures are found on disk, so a format of the pair table without one, a fixture deleted or a
    // format added to ConvertorFactory, would run none of its pairs and leave the check green.
    it("has a fixture of every format of the pair table", function () {
        const fixtureExtensions = new Set(fontFixtures.map((fixture) => fixture.extension));

        expect(Array.from(fixtureExtensions).sort()).to.deep.equal([...extensions].sort());
    });

    it("runs exactly the fixtures the list names", function () {
        const runRelativePaths = fontFixtures.map((fixture) => fixture.relativePath);

        expect(runRelativePaths).to.deep.equal(
            [...sourceFixtureRelativePaths].sort(),
            "sourceFixtureRelativePaths of expected-differences.ts names exactly the fonts of test/fixtures/fonts",
        );
    });

    // Without this an entry with a fixture or a pair the check does not run, a typo, a fixture renamed
    // or a pair dropped from the table, would wait in the list unnoticed: the loop above looks entries
    // up by the fixtures and the pairs that run.
    it("lists expected differences only for fixtures and pairs that run", function () {
        for (const expected of expectedDifferences) {
            for (const fixtureRelativePath of expected.fixtureRelativePaths) {
                const fixture = fontFixtures.find((fontFixture) => fontFixture.relativePath === fixtureRelativePath);

                if (fixture === undefined) {
                    expect.fail(`${fixtureRelativePath} is not a fixture: ${expected.reason}`);
                }

                for (const toExtension of expected.toExtensions) {
                    expect(() => factory.get(fixture.extension, toExtension), expected.reason).not.to.throw();
                }
            }
        }
    });

    // The Roboto fixtures at the root and the corpus of real fonts in a directory per font
    // (test/fixtures/fonts/README.md); licences and READMEs have no extension of the pair table. The
    // compressed EOT goes the whole way as a source of its own: the codec decodes MicroType Express on
    // unpacking, and the engine converts what it decodes. A font file is taken whether git tracks it or
    // not, since the container has no .git: an untracked font left in the directory runs too and fails the
    // check against sourceFixtureRelativePaths, which does not list it.
    function readFontFixtures(): Array<FontFixture> {
        const fixtures: Array<FontFixture> = [];

        for (const relativePath of readdirSync(fixtureDir, { recursive: true, encoding: "utf8" }).sort()) {
            const extension = extensions.find((supported) => path.extname(relativePath).toLowerCase() === `.${supported}`);

            if (extension !== undefined) {
                fixtures.push({ relativePath: relativePath, extension: extension });
            }
        }

        return fixtures;
    }
});
