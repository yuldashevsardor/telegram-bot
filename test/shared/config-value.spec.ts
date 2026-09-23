import { expect } from "chai";
import { configValue } from "app/shared/config-value";
import { fillApplicationContext, resetApplicationContext } from "test/bootstrap/application/application-context.helper";

// The spec needs only the way to the context: the walk by the path and its failures are checked by
// config-container.spec.ts.
describe("configValue", function () {
    afterEach(function () {
        resetApplicationContext();
    });

    it("resolves a dotted path from the context's config", async function () {
        await fillApplicationContext({ BOT_TOKEN: "token" });

        expect(configValue("bot.token")).to.equal("token");
    });
});
