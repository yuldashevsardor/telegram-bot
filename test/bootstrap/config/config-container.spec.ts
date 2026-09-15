import { expect } from "chai";
import { ConfigContainer } from "app/bootstrap/config/config-container";
import { ConfigContainerIsNotInitialized } from "app/bootstrap/config/config-container.errors";
import type { ConfigBuilder } from "app/bootstrap/config/builder/config-builder";
import type { ConfigStorage, RawConfig } from "app/bootstrap/config/storage/config-storage";
import { InvalidConfigError } from "app/shared/errors";

type Values = {
    tempDir: string;
    limits: {
        common: { number: number; interval: number };
    };
};

function storage(raw: RawConfig): ConfigStorage {
    return { load: async (): Promise<RawConfig> => raw };
}

// Билдер отдаёт то, что ему дали, без разбора: форма значений здесь расходится с объявленной
// намеренно — именно такое расхождение get() и ловит, компилятор его не видит.
function returning(values: object): ConfigBuilder<Values> {
    return { build: (): Values => values as Values };
}

async function container(values: object): Promise<ConfigContainer<Values>> {
    const cc = new ConfigContainer(storage({}), returning(values));
    await cc.init();

    return cc;
}

describe("ConfigContainer", () => {
    it("builds the values from what the storage has loaded", async () => {
        const builder: ConfigBuilder<Values> = {
            build: (raw): Values => ({ tempDir: raw["TEMP_DIR"] ?? "", limits: { common: { number: 1, interval: 1 } } }),
        };
        const cc = new ConfigContainer(storage({ TEMP_DIR: "/data/tmp" }), builder);

        await cc.init();

        expect(cc.get("tempDir")).to.equal("/data/tmp");
    });

    it("throws ConfigContainerIsNotInitialized before init()", () => {
        const cc = new ConfigContainer(storage({}), returning({ tempDir: "/tmp" }));

        expect(() => cc.get("tempDir"))
            .to.throw(ConfigContainerIsNotInitialized)
            .with.property("message", "ConfigContainer is not initialized, call init() first.");
    });

    it("resolves a dotted path", async () => {
        const common = { number: 30, interval: 1000 };
        const cc = await container({ tempDir: "/tmp", limits: { common: common } });

        expect(cc.get("limits.common")).to.equal(common);
        expect(cc.get("limits.common.interval")).to.equal(1000);
        expect(cc.get("tempDir")).to.equal("/tmp");
    });

    it("throws InvalidConfigError when the value is undefined", async () => {
        const cc = await container({});

        expect(() => cc.get("tempDir"))
            .to.throw(InvalidConfigError, 'Invalid config "tempDir"')
            .with.property("payload")
            .that.deep.equals({ path: "tempDir" });
    });

    it("throws InvalidConfigError when an object on the path is missing", async () => {
        const cc = await container({});

        expect(() => cc.get("limits.common"))
            .to.throw(InvalidConfigError)
            .with.property("payload")
            .that.deep.equals({ path: "limits.common" });
    });

    // typeof null — тоже "object": без отдельной проверки на null обход упал бы TypeError.
    it("throws InvalidConfigError when an object on the path is null", async () => {
        const cc = await container({ limits: null });

        expect(() => cc.get("limits.common"))
            .to.throw(InvalidConfigError)
            .with.property("payload")
            .that.deep.equals({ path: "limits.common" });
    });
});
