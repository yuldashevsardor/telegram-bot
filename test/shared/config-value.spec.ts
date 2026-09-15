import { expect } from "chai";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ConfigContainer } from "app/bootstrap/config/config-container";
import type { CC } from "app/bootstrap/config/config-container.types";
import type { ConfigValues } from "app/bootstrap/config/config-values";
import type { RawConfig } from "app/bootstrap/config/storage/config-storage";
import { configValue } from "app/shared/config-value";

type ContextParts = {
    cc: CC | null;
};

// Конфиг кладётся в статическое поле мимо create(), как в container.spec.ts: create() собрал бы
// его из настоящего окружения. Значения неполные намеренно: спеке нужен только путь до контекста,
// обход пути и его отказы проверяет config-container.spec.ts.
const context = ApplicationContext as unknown as ContextParts;

describe("configValue", function () {
    afterEach(function () {
        // Контекст общий на весь прогон mocha: заполненным он отдал бы этот конфиг чужим спекам.
        context.cc = null;
    });

    it("resolves a dotted path from the context's config", async function () {
        const cc = new ConfigContainer(
            { load: async (): Promise<RawConfig> => ({}) },
            { build: (): ConfigValues => ({ bot: { token: "token" } } as ConfigValues) },
        );
        await cc.init();
        context.cc = cc;

        expect(configValue("bot.token")).to.equal("token");
    });
});
