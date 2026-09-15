import { expect } from "chai";
import { configValue } from "app/shared/config-value";
import { fillApplicationContext, resetApplicationContext } from "test/bootstrap/application/application-context.helper";

// Спеке нужен только путь до контекста: обход пути и его отказы проверяет config-container.spec.ts.
describe("configValue", function () {
    afterEach(function () {
        resetApplicationContext();
    });

    it("resolves a dotted path from the context's config", async function () {
        await fillApplicationContext({ BOT_TOKEN: "token" });

        expect(configValue("bot.token")).to.equal("token");
    });
});
