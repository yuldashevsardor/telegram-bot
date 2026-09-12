import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ProcessHelper } from "app/shared/process/process-helper";
import { ProcessFailed } from "app/shared/process/process-helper.errors";

describe("ProcessHelper.run", function () {
    it("передаёт аргумент с shell-метасимволами как данные, а не как команду", async function () {
        const argument = '$(echo injected); `echo injected`; "quoted" & rm -rf /';

        const result = await ProcessHelper.run("/bin/echo", [argument]);

        expect(result.stdout.trim()).to.equal(argument);
    });

    it("не даёт аргументу дописать команду: побочного файла не появляется", async function () {
        const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "process-helper-"));
        const marker = path.join(basePath, "injected");

        try {
            await ProcessHelper.run("/bin/echo", [`x"; touch ${marker}; echo "`]);

            expect(await fileExists(marker)).to.be.false;
        } finally {
            await fs.rm(basePath, { recursive: true, force: true });
        }
    });

    it("бросает ProcessFailed с командой в payload, когда процесс завершился с ошибкой", async function () {
        try {
            await ProcessHelper.run("/bin/sh", ["-c", "exit 3"]);
            expect.fail("ожидалась ошибка ProcessFailed");
        } catch (error) {
            expect(error).to.be.instanceOf(ProcessFailed);
            expect((error as ProcessFailed).payload).to.deep.include({
                file: "/bin/sh",
                args: ["-c", "exit 3"],
            });
            expect((error as ProcessFailed).cause).to.be.instanceOf(Error);
        }
    });

    it("бросает ProcessFailed, когда исполняемого файла нет", async function () {
        try {
            await ProcessHelper.run("/nonexistent/binary");
            expect.fail("ожидалась ошибка ProcessFailed");
        } catch (error) {
            expect(error).to.be.instanceOf(ProcessFailed);
        }
    });

    async function fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);

            return true;
        } catch {
            return false;
        }
    }
});

describe("ProcessFailed.byCommand", function () {
    it("кладёт пойманное не-Error значение под cause в payload и берёт запасное сообщение", function () {
        // Значение подобрано так, чтобы не совпадать ни с file, ни с элементами args:
        // иначе тест не отличит пойманное от аргумента команды.
        const error = ProcessFailed.byCommand("/bin/sh", ["-c", "exit 3"], "SIGKILL");

        // Ключ от типа не зависит, глубина зависит: RuntimeError поднимает в нативный
        // cause только Error, поэтому строка остаётся в payload — и сообщение берётся
        // запасное, взять его у пойманного значения не у чего.
        expect(error.message).to.equal("Process /bin/sh failed.");
        expect(error.cause).to.be.undefined;
        expect(error.payload).to.deep.equal({ file: "/bin/sh", args: ["-c", "exit 3"], cause: "SIGKILL" });
    });
});
