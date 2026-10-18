import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import { HelpCommand } from "app/telegram/command/help/help.command";
import { HelpText } from "app/telegram/command/help/help-text";
import { createFluent } from "app/telegram/locale/locale";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import { command, runHandler, supportedFormats } from "test/telegram/reply-context.helper";

const helpText = new HelpText(supportedFormats, "@author");

describe("HelpCommand", function () {
    it("replies with the help on /help", async function () {
        const { ctx, replies, isPassedOn } = await runHandler(new HelpCommand(helpText), command("/help"));

        expect(replies).to.deep.equal([helpText.build(ctx)]);
        expect(isPassedOn).to.equal(false);
    });

    it("has a translated description for the command menu", async function () {
        const fluent = await createFluent(path.join(process.cwd(), "src", "telegram"));
        const { descriptionKey } = new HelpCommand(helpText);

        expect(fluent.translate(DEFAULT_LOCALE, descriptionKey)).to.not.equal(`{${descriptionKey}}`);
    });
});
