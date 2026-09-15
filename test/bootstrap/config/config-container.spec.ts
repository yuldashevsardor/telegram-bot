import { expect } from "chai";
import { ConfigContainer } from "app/bootstrap/config/config-container";
import { InvalidConfigError } from "app/shared/errors";

type Values = {
    tempDir: string;
    limits: {
        common: { number: number; interval: number };
    };
};

// Форма значений здесь расходится с объявленной намеренно: именно такое расхождение get() и ловит,
// компилятор его не видит.
function container(values: object): ConfigContainer<Values> {
    return new ConfigContainer(values as Values);
}

describe("ConfigContainer", () => {
    it("resolves a dotted path", () => {
        const common = { number: 30, interval: 1000 };
        const config = container({ tempDir: "/tmp", limits: { common: common } });

        expect(config.get("limits.common")).to.equal(common);
        expect(config.get("limits.common.interval")).to.equal(1000);
        expect(config.get("tempDir")).to.equal("/tmp");
    });

    it("throws InvalidConfigError when the value is undefined", () => {
        expect(() => container({}).get("tempDir"))
            .to.throw(InvalidConfigError, 'Invalid config "tempDir"')
            .with.property("payload")
            .that.deep.equals({ path: "tempDir" });
    });

    it("throws InvalidConfigError when an object on the path is missing", () => {
        expect(() => container({}).get("limits.common"))
            .to.throw(InvalidConfigError)
            .with.property("payload")
            .that.deep.equals({ path: "limits.common" });
    });

    // typeof null — тоже "object": без отдельной проверки на null обход упал бы TypeError.
    it("throws InvalidConfigError when an object on the path is null", () => {
        expect(() => container({ limits: null }).get("limits.common"))
            .to.throw(InvalidConfigError)
            .with.property("payload")
            .that.deep.equals({ path: "limits.common" });
    });
});
