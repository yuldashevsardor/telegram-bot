import { expect } from "chai";
import { TelegramApiFactory } from "app/telegram/telegram-api-factory";

const TOKEN = "123456:bot-token";

describe("TelegramApiFactory", function () {
    it("gives the Api the bot token and the timeout it is asked for", function () {
        const api = new TelegramApiFactory(TOKEN).create(2.5);

        expect(api.token).to.equal(TOKEN);
        expect(api.options).to.deep.equal({ timeoutSeconds: 2.5 });
    });

    it("installs no transformers on the Api", function () {
        const api = new TelegramApiFactory(TOKEN).create(2.5);

        expect(api.config.installedTransformers()).to.deep.equal([]);
    });
});
