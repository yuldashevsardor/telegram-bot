import { expect } from "chai";
import { InboxApiFactory } from "app/telegram/inbox/inbox-api-factory";

const TOKEN = "123456:inbox-token";

describe("InboxApiFactory", function () {
    it("gives the Api the bot token and the timeout it is asked for", function () {
        const api = new InboxApiFactory(TOKEN).create(40);

        expect(api.token).to.equal(TOKEN);
        expect(api.options).to.deep.equal({ timeoutSeconds: 40 });
    });

    it("installs no transformers on the Api", function () {
        const api = new InboxApiFactory(TOKEN).create(40);

        expect(api.config.installedTransformers()).to.deep.equal([]);
    });
});
