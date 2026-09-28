import { expect } from "chai";
import { PathFile } from "app/telegram/path-file/path-file";
import { RelativeFilePath } from "app/telegram/path-file/path-file.errors";

describe("PathFile", function () {
    it("keeps an absolute path", function () {
        expect(new PathFile("/data/fonts/result.woff2").path).to.equal("/data/fonts/result.woff2");
    });

    for (const path of ["fonts/result.woff2", "./result.woff2", ""]) {
        it(`rejects the relative path "${path}"`, function () {
            expect(() => new PathFile(path))
                .to.throw(RelativeFilePath, "PathFile got a relative path")
                .with.deep.property("payload", { path: path });
        });
    }
});
