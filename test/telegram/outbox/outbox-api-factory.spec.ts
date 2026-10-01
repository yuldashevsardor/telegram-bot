import { expect } from "chai";
import { OutboxApiFactory } from "app/telegram/outbox/outbox-api-factory";

const TOKEN = "123456:outbox-token";

describe("OutboxApiFactory", function () {
    it("gives the Api the bot token and the call timeout in seconds", function () {
        const api = new OutboxApiFactory(TOKEN, 2_500).create();

        expect(api.token).to.equal(TOKEN);
        expect(api.options).to.deep.equal({ timeoutSeconds: 2.5 });
    });

    it("installs no transformers on the Api", function () {
        const api = new OutboxApiFactory(TOKEN, 2_500).create();

        expect(api.config.installedTransformers()).to.deep.equal([]);
    });
});
