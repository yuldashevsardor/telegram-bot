import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import { HelpCommand } from "app/telegram/command/help/help.command";
import { createFluent } from "app/telegram/locale/locale";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import { command, helpText, runHandler } from "test/telegram/reply-context.helper";

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
