import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { FileHelper } from "app/shared/fs/file-helper";
import type { RuntimeError } from "app/shared/errors";
import {
    InvalidExtensions,
    InvalidFile,
    InvalidPath,
    PermissionDenied,
    ReadFailed,
    RemoveFailed,
    WriteFailed,
} from "app/shared/fs/file-helper.errors";

// Права проверяет access(2), а root проходит его при любых битах: тесты с chmod рассчитаны
// на непривилегированного пользователя, как node в Dockerfile.
async function withMode(target: string, mode: number, check: () => Promise<void>): Promise<void> {
    const { mode: original } = await fs.stat(target);
    await fs.chmod(target, mode);

    try {
        await check();
    } finally {
        await fs.chmod(target, original & 0o7777);
    }
}

// Вызов, который не бросил, падает сообщением «call did not throw»: брошенный внутри try,
// AssertionError поймал бы собственный catch, и отказ читался бы как ошибка не того класса.
function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
    return call().then(
        () => expect.fail("call did not throw"),
        (error: unknown) => error,
    );
}

// Спеки идут в образе на Linux, где открытые дескрипторы процесса перечислены в /proc/self/fd.
async function openDescriptors(): Promise<number> {
    return (await fs.readdir("/proc/self/fd")).length;
}

async function expectRejection(call: () => Promise<unknown>, expected: RuntimeError): Promise<void> {
    const error = await rejectionOf(call);

    expect(error).to.be.instanceOf(expected.constructor);
    expect((error as RuntimeError).message).to.equal(expected.message);
    expect((error as RuntimeError).payload).to.deep.equal(expected.payload);
}

describe("FileHelper.isExist", function () {
    let basePath: string;

    beforeEach(async function () {
        basePath = await fs.mkdtemp(path.join(os.tmpdir(), "file-helper-"));
    });

    afterEach(async function () {
        await fs.rm(basePath, { recursive: true, force: true });
    });

    it("reports an unreadable path as existing", async function () {
        const filePath = path.join(basePath, "locked.bin");
        await fs.writeFile(filePath, Uint8Array.from([1]));

        await withMode(filePath, 0o000, async () => {
            expect(await FileHelper.isExist(filePath)).to.be.true;
            expect(await FileHelper.isReadable(filePath)).to.be.false;
        });
    });

    it("reports a missing path as not existing", async function () {
        expect(await FileHelper.isExist(path.join(basePath, "missing.bin"))).to.be.false;
    });
});

describe("FileHelper.getFileExtension", function () {
    it("returns the extension without the dot", async function () {
        expect(await FileHelper.getFileExtension("/fonts/font.ttf")).to.equal("ttf");
    });

    it("returns an empty string for a name without an extension", async function () {
        expect(await FileHelper.getFileExtension("/fonts/font")).to.equal("");
    });
});

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

    it("reuses the directories that already exist", async function () {
        const first = await FileHelper.createDirectoriesByDate(basePath);
        const second = await FileHelper.createDirectoriesByDate(basePath);
        const after = dayjs();

        // Второй вызов мог пересечь полночь и завести соседний день.
        expect([first, expectedPath(after)]).to.include(second);
    });

    it("refuses a base path that does not exist", async function () {
        const missingPath = path.join(basePath, "missing");

        await expectRejection(() => FileHelper.createDirectoriesByDate(missingPath), InvalidPath.isNotExist(missingPath));
    });

    it("refuses a base path that is not readable", async function () {
        await withMode(basePath, 0o000, async () => {
            await expectRejection(() => FileHelper.createDirectoriesByDate(basePath), PermissionDenied.read(basePath));
        });
    });

    it("refuses a base path that is not writable", async function () {
        await withMode(basePath, 0o500, async () => {
            await expectRejection(() => FileHelper.createDirectoriesByDate(basePath), PermissionDenied.write(basePath));
        });
    });

    it("refuses a base path that is a file", async function () {
        const filePath = path.join(basePath, "file.bin");
        await fs.writeFile(filePath, Uint8Array.from([1]));

        await expectRejection(() => FileHelper.createDirectoriesByDate(filePath), InvalidPath.isNotDirectory(filePath));
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

    it("wraps an error that comes after the file was opened", async function () {
        // Каталог открывается на чтение, а падает уже само чтение (EISDIR).
        const error = await rejectionOf(() => FileHelper.readHead(basePath, 4));

        expect(error).to.be.instanceOf(ReadFailed);
        expect((error as ReadFailed).payload).to.deep.equal({ path: basePath });
        expect((error as ReadFailed).cause).to.be.instanceOf(Error);
    });

    it("closes the file whether the read succeeds or fails", async function () {
        const filePath = path.join(basePath, "head.bin");
        await fs.writeFile(filePath, Uint8Array.from([1, 2, 3]));
        const before = await openDescriptors();

        await FileHelper.readHead(filePath, 3);
        await rejectionOf(() => FileHelper.readHead(basePath, 4));

        expect(await openDescriptors()).to.equal(before);
    });
});

describe("FileHelper.findFilesByExtensions", function () {
    let basePath: string;

    beforeEach(async function () {
        basePath = await fs.mkdtemp(path.join(os.tmpdir(), "file-helper-"));
    });

    afterEach(async function () {
        await fs.rm(basePath, { recursive: true, force: true });
    });

    it("takes extensions with or without a leading dot", async function () {
        for (const name of ["a.ttf", "b.otf", "c.txt"]) {
            await fs.writeFile(path.join(basePath, name), Uint8Array.from([1]));
        }

        const files = await FileHelper.findFilesByExtensions(basePath, [" .ttf", "otf"]);

        expect(files.sort()).to.deep.equal([path.join(basePath, "a.ttf"), path.join(basePath, "b.otf")]);
    });

    it("skips directories that match the extension", async function () {
        await fs.writeFile(path.join(basePath, "a.ftl"), Uint8Array.from([1]));
        await fs.mkdir(path.join(basePath, "b.ftl"));

        expect(await FileHelper.findFilesByExtensions(basePath, ["ftl"])).to.deep.equal([path.join(basePath, "a.ftl")]);
    });

    // Локали собираются из всех .ftl каталога (createFluent), и скрытый ._start.locale.en.ftl —
    // файл метаданных, который macOS кладёт рядом на чужой файловой системе, — ушёл бы в бандл en.
    it("skips hidden files", async function () {
        await fs.writeFile(path.join(basePath, "start.locale.en.ftl"), Uint8Array.from([1]));
        await fs.writeFile(path.join(basePath, "._start.locale.en.ftl"), Uint8Array.from([1]));

        expect(await FileHelper.findFilesByExtensions(basePath, ["ftl"])).to.deep.equal([path.join(basePath, "start.locale.en.ftl")]);
    });

    it("refuses a list with nothing but blanks", async function () {
        const extensions = [" ", "."];

        await expectRejection(() => FileHelper.findFilesByExtensions(basePath, extensions), InvalidExtensions.empty(extensions));
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

describe("ReadFailed, WriteFailed and RemoveFailed", function () {
    const cases = [
        {
            name: "ReadFailed",
            build: (filePath: string, cause: unknown): RuntimeError => ReadFailed.byPath(filePath, cause),
            fallback: "Cannot read file /x/y.",
        },
        {
            name: "WriteFailed",
            build: (filePath: string, cause: unknown): RuntimeError => WriteFailed.byPath(filePath, cause),
            fallback: "Cannot write file /x/y.",
        },
        {
            name: "RemoveFailed",
            build: (filePath: string, cause: unknown): RuntimeError => RemoveFailed.byPath(filePath, cause),
            fallback: "Cannot remove file /x/y.",
        },
    ];

    for (const { name, build, fallback } of cases) {
        it(`${name} keeps a caught value that is not an Error under cause in the payload`, function () {
            const error = build("/x/y", "EACCES");

            // Ключ от типа не зависит, глубина зависит: RuntimeError поднимает в нативный
            // cause только Error, поэтому строка остаётся в payload — и сообщение берётся
            // запасное, взять его у пойманного значения не у чего.
            expect(error.message).to.equal(fallback);
            expect(error.cause).to.be.undefined;
            expect(error.payload).to.deep.equal({ path: "/x/y", cause: "EACCES" });
        });
    }
});

describe("PermissionDenied, InvalidPath, InvalidFile and InvalidExtensions", function () {
    // Фабрики проверяются напрямую: FileHelper бросает не все, а спеки выше сверяют отказ с
    // ошибкой той же фабрики, и её сообщение и payload там сравниваются сами с собой.
    const cases = [
        {
            name: "PermissionDenied.read",
            error: PermissionDenied.read("/x/y"),
            type: PermissionDenied,
            message: "Path /x/y is not readable.",
            payload: { path: "/x/y" },
        },
        {
            name: "PermissionDenied.write",
            error: PermissionDenied.write("/x/y"),
            type: PermissionDenied,
            message: "Path /x/y is not writable.",
            payload: { path: "/x/y" },
        },
        {
            name: "InvalidPath.isNotFile",
            error: InvalidPath.isNotFile("/x/y"),
            type: InvalidPath,
            message: "/x/y is not file.",
            payload: { path: "/x/y" },
        },
        {
            name: "InvalidPath.isNotDirectory",
            error: InvalidPath.isNotDirectory("/x/y"),
            type: InvalidPath,
            message: "/x/y is not directory.",
            payload: { path: "/x/y" },
        },
        {
            name: "InvalidPath.isNotExist",
            error: InvalidPath.isNotExist("/x/y"),
            type: InvalidPath,
            message: "/x/y is not exists.",
            payload: { path: "/x/y" },
        },
        {
            name: "InvalidPath.isAlreadyExists",
            error: InvalidPath.isAlreadyExists("/x/y"),
            type: InvalidPath,
            message: "/x/y is already exists.",
            payload: { path: "/x/y" },
        },
        {
            name: "InvalidFile.byPathAndExtension",
            error: InvalidFile.byPathAndExtension("/x/y.txt", "txt", "ttf"),
            type: InvalidFile,
            message: "File /x/y.txt extension is invalid. Got: txt, allowed: ttf.",
            payload: { path: "/x/y.txt", extension: "txt", allowed: "ttf" },
        },
        {
            name: "InvalidExtensions.empty",
            error: InvalidExtensions.empty([" ", "."]),
            type: InvalidExtensions,
            message: "Extensions cannot be empty.",
            payload: { extensions: [" ", "."] },
        },
    ];

    for (const { name, error, type, message, payload } of cases) {
        it(`${name} keeps its message and details`, function () {
            expect(error).to.be.instanceOf(type);
            expect(error.message).to.equal(message);
            expect(error.payload).to.deep.equal(payload);
        });
    }

    // Сообщение не сверяется: в src/ эту фабрику никто не вызывает.
    it("InvalidFile.byPath keeps its details in the payload", function () {
        const error = InvalidFile.byPath("/x/y");

        expect(error).to.be.instanceOf(InvalidFile);
        expect(error.payload).to.deep.equal({ path: "/x/y" });
    });
});
