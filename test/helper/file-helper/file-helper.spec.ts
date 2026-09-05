import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import dayjs, { Dayjs } from "dayjs";
import { FileHelper } from "app/helper/file-helper/file-helper";

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
