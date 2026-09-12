import "reflect-metadata";
import { expect } from "chai";
import { Context, Conversation } from "app/telegram/bot.types";
import { StartConversation } from "app/telegram/conversation/start/start.conversation";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/font-signature-matcher";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";

describe("StartConversation", function () {
    it("promises exactly the supported formats", async function () {
        const convertorFactory = new ConvertorFactory({} as FontForge, new FontSignatureMatcher(), new EotPacker());
        const startConversation = new StartConversation(convertorFactory);
        let formats: unknown = undefined;

        const ctx = {
            t: (key: string, args?: Record<string, unknown>): string => {
                if (key === "start-conversation-welcome") {
                    formats = args?.["formats"];
                }

                return key;
            },
            reply: async (): Promise<void> => undefined,
        } as unknown as Context;

        const nextMessage = {
            message: { text: "font" },
            reply: async (): Promise<void> => undefined,
            t: (key: string): string => key,
        } as unknown as Context;

        const conversation = {
            wait: async (): Promise<Context> => nextMessage,
        } as unknown as Conversation;

        await startConversation.handle(conversation, ctx);

        expect(formats).to.equal(convertorFactory.getSupportedExtensions().join(", "));
    });
});
