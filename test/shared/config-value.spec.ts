import { expect } from "chai";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ConfigContainer } from "app/bootstrap/config-container";
import { configValue } from "app/shared/config-value";

type ContextParts = {
    config: ConfigContainer | null;
};

// Конфиг кладётся в статическое поле мимо create(), как в container.spec.ts: create() собрал бы
// его из настоящего окружения. Обход пути и его отказы проверяет config-container.spec.ts.
const context = ApplicationContext as unknown as ContextParts;

describe("configValue", function () {
    afterEach(function () {
        // Контекст общий на весь прогон mocha: заполненным он отдал бы этот конфиг чужим спекам.
        context.config = null;
    });

    it("resolves a dotted path from the context's config", function () {
        context.config = new ConfigContainer({ get: (key): string | undefined => (key === "BOT_TOKEN" ? "token" : undefined) });

        expect(configValue("limits.common")).to.deep.equal({ number: 30, interval: 1000 });
        expect(configValue("bot.token")).to.equal("token");
    });
});
