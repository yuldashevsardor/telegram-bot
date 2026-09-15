import "reflect-metadata";
import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";

const KEY = "CONFIG_ENV_STORAGE_SPEC_VALUE";
const FILE_KEY = "CONFIG_ENV_STORAGE_SPEC_FILE_VALUE";

// dotenv ищет .env в текущем каталоге процесса. Каталог меняется и возвращается в одном
// синхронном вызове: асинхронный код соседних спек чужого cwd не застанет.
function createIn(directory: string): ConfigEnvStorage {
    const cwd = process.cwd();
    process.chdir(directory);

    try {
        return new ConfigEnvStorage();
    } finally {
        process.chdir(cwd);
    }
}

function withEnv(value: string | undefined, assertion: (storage: ConfigEnvStorage) => void): void {
    const original = process.env[KEY];

    if (value === undefined) {
        delete process.env[KEY];
    } else {
        process.env[KEY] = value;
    }

    try {
        assertion(new ConfigEnvStorage());
    } finally {
        if (original === undefined) {
            delete process.env[KEY];
        } else {
            process.env[KEY] = original;
        }
    }
}

describe("ConfigEnvStorage", () => {
    it("reads a value from the process environment", () => {
        withEnv("value", (storage) => {
            expect(storage.get(KEY)).to.equal("value");
        });
    });

    it("returns the value as is, without trimming or parsing", () => {
        withEnv("  10  ", (storage) => {
            expect(storage.get(KEY)).to.equal("  10  ");
        });
    });

    it("returns undefined for a key that is not set", () => {
        withEnv(undefined, (storage) => {
            expect(storage.get(KEY)).to.equal(undefined);
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

        it("loads its values into the process environment", () => {
            expect(createIn(workDir).get(FILE_KEY)).to.equal("from-file");
        });

        // Почему stdout должен молчать — комментарий у dotenv.config() в ConfigEnvStorage.
        it("writes nothing to stdout while loading it", () => {
            const original = process.stdout.write;
            let captured = "";
            process.stdout.write = ((chunk: string): boolean => {
                captured += chunk;

                return true;
            }) as typeof process.stdout.write;

            try {
                createIn(workDir);
            } finally {
                process.stdout.write = original;
            }

            expect(captured).to.equal("");
        });
    });
});
