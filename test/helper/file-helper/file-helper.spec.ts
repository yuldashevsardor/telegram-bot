import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import dayjs, { Dayjs } from "dayjs";
import { FileHelper } from "app/helper/file-helper/file-helper";
import { ReadFailed, RemoveFailed, WriteFailed } from "app/helper/file-helper/file-helper.errors";

describe("FileHelper.createDirectoriesByDate", function () {
    let basePath: string;

    beforeEach(async function () {
        basePath = await fs.mkdtemp(path.join(os.tmpdir(), "file-helper-"));
    });

    afterEach(async function () {
        await fs.rm(basePath, { recursive: true, force: true });
    });

    it("creates a directory named by the calendar date", async function () {
        const before = dayjs();
        const createdPath = await FileHelper.createDirectoriesByDate(basePath);
        const after = dayjs();

        // Два ожидаемых пути, потому что прогон может пересечь полночь.
        expect([expectedPath(before), expectedPath(after)]).to.include(createdPath);
        expect(await FileHelper.isDirectory(createdPath)).to.be.true;
    });

    function expectedPath(dateTime: Dayjs): string {
        return path.join(basePath, dateTime.year().toString(), (dateTime.month() + 1).toString(), dateTime.date().toString());
    }
});

describe("FileHelper.readHead", function () {
    let basePath: string;

    beforeEach(async function () {
        basePath = await fs.mkdtemp(path.join(os.tmpdir(), "file-helper-"));
    });

    afterEach(async function () {
        await fs.rm(basePath, { recursive: true, force: true });
    });

    it("reads the first bytes of a file", async function () {
        const filePath = path.join(basePath, "head.bin");
        await fs.writeFile(filePath, Uint8Array.from([1, 2, 3, 4, 5]));

        expect(Array.from(await FileHelper.readHead(filePath, 3))).to.deep.equal([1, 2, 3]);
    });

    it("returns what there is when the file is shorter", async function () {
        const filePath = path.join(basePath, "short.bin");
        await fs.writeFile(filePath, Uint8Array.from([1, 2]));

        expect(Array.from(await FileHelper.readHead(filePath, 8))).to.deep.equal([1, 2]);
    });

    it("wraps a system error instead of letting it out", async function () {
        try {
            await FileHelper.readHead(path.join(basePath, "missing.bin"), 4);
            expect.fail("readHead did not throw");
        } catch (error) {
            expect(error).to.be.instanceOf(ReadFailed);
            expect((error as ReadFailed).payload).to.have.property("path");
            expect((error as ReadFailed).cause).to.be.instanceOf(Error);
        }
    });
});

describe("FileHelper.read, write and remove", function () {
    let basePath: string;

    beforeEach(async function () {
        basePath = await fs.mkdtemp(path.join(os.tmpdir(), "file-helper-"));
    });

    afterEach(async function () {
        await fs.rm(basePath, { recursive: true, force: true });
    });

    it("writes a file and reads it back whole", async function () {
        const filePath = path.join(basePath, "whole.bin");
        await FileHelper.write(filePath, Uint8Array.from([1, 2, 3, 4, 5]));

        expect(Array.from(await FileHelper.read(filePath))).to.deep.equal([1, 2, 3, 4, 5]);
    });

    it("writes only the part of the buffer it was given", async function () {
        // Кодек отдаёт на запись не самостоятельный буфер, а окно в чужом: там лежит
        // шрифт, вынутый из конверта.
        const filePath = path.join(basePath, "window.bin");
        await FileHelper.write(filePath, Uint8Array.from([1, 2, 3, 4, 5]).subarray(2));

        expect(Array.from(await FileHelper.read(filePath))).to.deep.equal([3, 4, 5]);
    });

    it("removes a file", async function () {
        const filePath = path.join(basePath, "gone.bin");
        await FileHelper.write(filePath, Uint8Array.from([1]));
        await FileHelper.remove(filePath);

        expect(await FileHelper.isExist(filePath)).to.be.false;
    });

    it("takes a missing path as nothing to remove", async function () {
        await FileHelper.remove(path.join(basePath, "never-was.bin"));
    });

    it("wraps a system error instead of letting it out", async function () {
        await expectWrapped(() => FileHelper.read(path.join(basePath, "missing.bin")), ReadFailed);
        await expectWrapped(() => FileHelper.write(path.join(basePath, "no", "such", "dir.bin"), new Uint8Array()), WriteFailed);
        await expectWrapped(() => FileHelper.remove(basePath), RemoveFailed);
    });

    async function expectWrapped(call: () => Promise<unknown>, expected: new (...params: never) => Error): Promise<void> {
        try {
            await call();
            expect.fail(`call did not throw ${expected.name}`);
        } catch (error) {
            expect(error).to.be.instanceOf(expected);
            expect((error as ReadFailed).payload).to.have.property("path");
            expect((error as ReadFailed).cause).to.be.instanceOf(Error);
        }
    }
});
