import "reflect-metadata";
import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import type { RawConfig } from "app/bootstrap/config/config-container/config-container.types";

const KEY = "CONFIG_ENV_STORAGE_SPEC_VALUE";
const FILE_KEY = "CONFIG_ENV_STORAGE_SPEC_FILE_VALUE";

// dotenv ищет .env в текущем каталоге процесса. Каталог меняется и возвращается в одном
// синхронном вызове: тело load() до первого await выполняется сразу, а await в нём нет, поэтому
// асинхронный код соседних спек чужого cwd не застанет.
function loadIn(directory: string): Promise<RawConfig> {
    const cwd = process.cwd();
    process.chdir(directory);

    try {
        return new ConfigEnvStorage().load();
    } finally {
        process.chdir(cwd);
    }
}

async function withEnv(value: string | undefined, assertion: (raw: RawConfig) => void): Promise<void> {
    const original = process.env[KEY];

    if (value === undefined) {
        delete process.env[KEY];
    } else {
        process.env[KEY] = value;
    }

    try {
        assertion(await new ConfigEnvStorage().load());
    } finally {
        if (original === undefined) {
            delete process.env[KEY];
        } else {
            process.env[KEY] = original;
        }
    }
}

describe("ConfigEnvStorage", () => {
    it("reads a value from the process environment", async () => {
        await withEnv("value", (raw) => {
            expect(raw[KEY]).to.equal("value");
        });
    });

    it("returns the value as is, without trimming or parsing", async () => {
        await withEnv("  10  ", (raw) => {
            expect(raw[KEY]).to.equal("  10  ");
        });
    });

    it("returns undefined for a key that is not set", async () => {
        await withEnv(undefined, (raw) => {
            expect(raw[KEY]).to.equal(undefined);
        });
    });

    // Снимок, а не сам process.env: сборка конфига не должна видеть переменные, поменявшиеся после load().
    it("returns a snapshot that later changes of the environment do not reach", async () => {
        await withEnv("before", (raw) => {
            process.env[KEY] = "after";

            expect(raw[KEY]).to.equal("before");
        });
    });

    describe("with .env in the working directory", () => {
        let workDir: string;

        before(async () => {
            workDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-env-storage-"));
            await fs.writeFile(path.join(workDir, ".env"), `${FILE_KEY}=from-file\n`);
        });

        afterEach(() => {
            delete process.env[FILE_KEY];
        });

        after(async () => {
            await fs.rm(workDir, { recursive: true, force: true });
        });

        it("loads its values", async () => {
            expect((await loadIn(workDir))[FILE_KEY]).to.equal("from-file");
        });

        // Почему stdout должен молчать — комментарий у dotenv.config() в ConfigEnvStorage.
        it("writes nothing to stdout while loading it", async () => {
            const original = process.stdout.write;
            let captured = "";
            process.stdout.write = ((chunk: string): boolean => {
                captured += chunk;

                return true;
            }) as typeof process.stdout.write;

            // Подмена снимается до await: dotenv пишет синхронно внутри load(), а за время ожидания в
            // stdout успел бы написать кто-то чужой.
            let loaded: Promise<RawConfig>;

            try {
                loaded = loadIn(workDir);
            } finally {
                process.stdout.write = original;
            }

            await loaded;

            expect(captured).to.equal("");
        });
    });
});
