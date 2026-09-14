import { expect } from "chai";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import type { ConfigContainer } from "app/bootstrap/config-container";
import { configValue } from "app/shared/config-value";
import { InvalidConfigError } from "app/shared/errors";

type ContextParts = {
    config: ConfigContainer | null;
};

// Конфиг кладётся в статическое поле мимо create(), как в container.spec.ts: create() собрал бы
// его из настоящего окружения. Форма конфига здесь расходится с объявленной намеренно —
// именно такое расхождение configValue и ловит, компилятор его не видит.
const context = ApplicationContext as unknown as ContextParts;

function useConfig(config: object): void {
    context.config = config as ConfigContainer;
}

describe("configValue", function () {
    afterEach(function () {
        // Контекст общий на весь прогон mocha: заполненным он отдал бы этот конфиг чужим спекам.
        context.config = null;
    });

    it("resolves a dotted path", function () {
        const common = { number: 30, interval: 1000 };
        useConfig({ limits: { common: common } });

        expect(configValue("limits.common")).to.equal(common);
    });

    it("throws InvalidConfigError when the value is undefined", function () {
        useConfig({});

        expect(() => configValue("tempDir"))
            .to.throw(InvalidConfigError, 'Invalid config "tempDir"')
            .with.property("payload")
            .that.deep.equals({ path: "tempDir" });
    });

    it("throws InvalidConfigError when an object on the path is missing", function () {
        useConfig({});

        expect(() => configValue("limits.common"))
            .to.throw(InvalidConfigError)
            .with.property("payload")
            .that.deep.equals({ path: "limits.common" });
    });

    // typeof null — тоже "object": без отдельной проверки на null обход упал бы TypeError.
    it("throws InvalidConfigError when an object on the path is null", function () {
        useConfig({ limits: null });

        expect(() => configValue("limits.common"))
            .to.throw(InvalidConfigError)
            .with.property("payload")
            .that.deep.equals({ path: "limits.common" });
    });
});
