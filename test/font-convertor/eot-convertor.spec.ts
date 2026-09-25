import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import type { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import { InvalidPath, RemoveFailed } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

type StepName = "fontForge" | "pack" | "unpack";

// The EOT pairs run on a stub engine and a stub codec. What matters here is the order of the
// steps and the fate of the intermediate file. What the engine and the codec do with the bytes
// is left to their own specs.
describe("Convertors of the eot pairs", function () {
    let workDir: string;
    let steps: Array<string>;
    let factory: ConvertorFactory;
    let failOn: StepName | undefined;
    let unremovableOn: StepName | undefined;

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eot-convertor-"));
        steps = [];
        failOn = undefined;
        unremovableOn = undefined;
        factory = new ConvertorFactory(fontForge(), new FontSignatureMatcher(), eotPacker());
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    it("goes through the engine and then the packer on the way to eot", async function () {
        const result = await convert(Extension.WOFF, Extension.EOT);

        expect(steps).to.deep.equal([`fontForge ${source(Extension.WOFF)} -> ${result}.ttf`, `pack ${result}.ttf -> ${result}`]);
    });

    it("goes through the packer and then the engine on the way from eot", async function () {
        const result = await convert(Extension.EOT, Extension.WOFF);

        expect(steps).to.deep.equal([`unpack ${source(Extension.EOT)} -> ${result}.ttf`, `fontForge ${result}.ttf -> ${result}`]);
    });

    it("keeps the engine out of the ttf pairs entirely", async function () {
        const toEot = await convert(Extension.TTF, Extension.EOT);
        const fromEot = await convert(Extension.EOT, Extension.TTF);

        expect(steps).to.deep.equal([`pack ${source(Extension.TTF)} -> ${toEot}`, `unpack ${source(Extension.EOT)} -> ${fromEot}`]);
    });

    it("removes the intermediate font after a successful conversion", async function () {
        const result = await convert(Extension.SVG, Extension.EOT);

        expect(await exists(`${result}.ttf`), "the intermediate sfnt is left behind").to.be.false;
        expect(await exists(result)).to.be.true;
    });

    it("removes the intermediate font after a failed conversion too", async function () {
        failOn = "pack";

        const error = await rejectionOf(() => convert(Extension.OTF, Extension.EOT));

        // Without checking the message the test would also pass on a rejection back in
        // validate(), where no intermediate file is made at all.
        expect((error as Error).message).to.equal("pack failed");
        expect(await exists(path.join(workDir, `result.${Extension.EOT}.ttf`))).to.be.false;
    });

    it("fails when only the removal of the intermediate font fails", async function () {
        unremovableOn = "fontForge";

        expect(await rejectionOf(() => convert(Extension.OTF, Extension.EOT))).to.be.instanceOf(RemoveFailed);
    });

    it("keeps the original failure when the removal fails after it", async function () {
        unremovableOn = "fontForge";
        failOn = "pack";

        const error = await rejectionOf(() => convert(Extension.OTF, Extension.EOT));

        expect(error).to.not.be.instanceOf(RemoveFailed);
        expect((error as Error).message).to.equal("pack failed");
        // The original failure is the same when the removal succeeds: without this check the
        // test would pass even if the intermediate path could be removed.
        expect(await exists(path.join(workDir, `result.${Extension.EOT}.ttf`)), "the intermediate sfnt was removed").to.be.true;
    });

    // A pass and a rejection are pinned for every pair: each pair calls Convertor.validate()
    // itself, and the EOT pairs have four implementations of convert(). The branches of the check
    // itself run in convertor.spec.ts. Only the pass covers the result extension: the rejection on
    // an occupied path happens before that extension is checked.
    const eotPairs = new ConvertorFactory(fontForge(), new FontSignatureMatcher(), eotPacker())
        .getSupportedExtensions()
        .filter((extension) => extension !== Extension.EOT)
        .flatMap(
            (extension): Array<[Extension, Extension]> => [
                [extension, Extension.EOT],
                [Extension.EOT, extension],
            ],
        );

    for (const [from, to] of eotPairs) {
        it(`converts ${from} to ${to}`, async function () {
            const newPath = await convert(from, to);

            expect(await exists(newPath)).to.be.true;
        });

        it(`refuses to write ${from} to ${to} over an existing file, touching neither the engine nor the packer`, async function () {
            const newPath = result(to);
            await fs.writeFile(newPath, Uint8Array.from([0]));

            const error = await rejectionOf(() => factory.get(from, to).convert(source(from), newPath));

            expect(error).to.be.instanceOf(InvalidPath);
            expect((error as InvalidPath).message).to.equal(InvalidPath.isAlreadyExists(newPath).message);
            expect(steps).to.be.empty;
        });
    }

    async function convert(from: Extension, to: Extension): Promise<string> {
        const newPath = result(to);

        await factory.get(from, to).convert(source(from), newPath);

        return newPath;
    }

    function source(extension: Extension): string {
        return path.join(fixtureDir, `test-font.${extension}`);
    }

    function result(extension: Extension): string {
        return path.join(workDir, `result.${extension}`);
    }

    // A stub step writes a file at its result path. Without it a removed intermediate sfnt could
    // not be told from one never created. The unremovableOn step leaves a directory instead of a
    // file, so that the removal fails: FileHelper.remove() removes files only.
    async function step(name: StepName, fromPath: string, toPath: string): Promise<void> {
        steps.push(`${name} ${fromPath} -> ${toPath}`);

        if (failOn === name) {
            throw new Error(`${name} failed`);
        }

        if (unremovableOn === name) {
            await fs.mkdir(toPath);
        } else {
            await fs.writeFile(toPath, Uint8Array.from([0]));
        }
    }

    function fontForge(): FontForge {
        return { convert: (fromPath: string, toPath: string) => step("fontForge", fromPath, toPath) } as FontForge;
    }

    function eotPacker(): EotPacker {
        return {
            pack: (fromPath: string, toPath: string) => step("pack", fromPath, toPath),
            unpack: (fromPath: string, toPath: string) => step("unpack", fromPath, toPath),
        } as EotPacker;
    }

    async function exists(filePath: string): Promise<boolean> {
        return await fs
            .access(filePath)
            .then(() => true)
            .catch(() => false);
    }

    function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
        return call().then(
            () => expect.fail("call did not throw"),
            (error: unknown) => error,
        );
    }
});
