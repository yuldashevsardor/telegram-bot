import { expect } from "chai";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ConfigContainer } from "app/bootstrap/config/config-container";
import type { ConfigValues } from "app/bootstrap/config/config-values";
import { configValue } from "app/shared/config-value";

type ContextParts = {
    config: ConfigContainer<ConfigValues> | null;
};

// Конфиг кладётся в статическое поле мимо create(), как в container.spec.ts: create() собрал бы
// его из настоящего окружения. Значения неполные намеренно: спеке нужен только путь до контекста,
// обход пути и его отказы проверяет config-container.spec.ts.
const context = ApplicationContext as unknown as ContextParts;

describe("configValue", function () {
    afterEach(function () {
        // Контекст общий на весь прогон mocha: заполненным он отдал бы этот конфиг чужим спекам.
        context.config = null;
    });

    it("resolves a dotted path from the context's config", function () {
        context.config = new ConfigContainer({ bot: { token: "token" } } as ConfigValues);

        expect(configValue("bot.token")).to.equal("token");
    });
});
