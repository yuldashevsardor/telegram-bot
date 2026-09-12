import "reflect-metadata";
import { expect } from "chai";
import { ConfigEnvStorage } from "app/platform/config/config-env-storage";

const KEY = "CONFIG_ENV_STORAGE_SPEC_VALUE";

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
});
