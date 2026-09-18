import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import { FileHelper } from "app/shared/fs/file-helper";
import { InvalidPath } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// Пары без EOT идут на настоящем fontforge из образа: у такой пары нет своей логики, кроме
// проверки входа и вызова движка, и подставной движок подтвердил бы только вызов, а не то,
// что пара достижима. Проверку каждая пара вызывает сама, поэтому и отказ закреплён у
// каждой; ветви самой проверки гоняет convertor.spec.ts.
describe("Convertors of the engine pairs", function () {
    const matcher = new FontSignatureMatcher();
    const factory = new ConvertorFactory(new FontForge("fontforge"), matcher, new EotPacker());
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

                const head = await FileHelper.readHead(toPath, matcher.headLength);
                expect(matcher.matches(head, toExtension), "результат не в целевом формате").to.be.true;
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
                expect(await fs.readFile(toPath), "движок записал поверх существующего файла").to.deep.equal(Buffer.from(existing));
            });
        }
    }

    function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
        return call().then(
            () => expect.fail("call did not throw"),
            (error: unknown) => error,
        );
    }
});
