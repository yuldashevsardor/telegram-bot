import "reflect-metadata";
import { expect } from "chai";
import type { Message } from "@grammyjs/types";
import type { Context, Conversation } from "app/telegram/bot.types";
import { StartConversation } from "app/telegram/conversation/start/start.conversation";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/font-signature-matcher";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";

type Run = { formats: unknown; events: string[] };

function buildConvertorFactory(): ConvertorFactory {
    return new ConvertorFactory({} as FontForge, new FontSignatureMatcher(), new EotPacker());
}

async function run(convertorFactory: ConvertorFactory, nextMessage: Partial<Message>): Promise<Run> {
    const result: Run = { formats: undefined, events: [] };

    const ctx = {
        t: (key: string, args?: Record<string, unknown>): string => {
            if (key === "start-conversation-welcome") {
                result.formats = args?.["formats"];
            }

            return key;
        },
        reply: async (text: string): Promise<void> => {
            result.events.push(`reply: ${text}`);
        },
    } as unknown as Context;

    const next = {
        message: nextMessage,
        reply: async (text: string): Promise<void> => {
            result.events.push(`reply to next: ${text}`);
        },
        t: (key: string): string => key,
    } as unknown as Context;

    const conversation = {
        wait: async (): Promise<Context> => {
            result.events.push("wait");

            return next;
        },
    } as unknown as Conversation;

    await new StartConversation(convertorFactory).handle(conversation, ctx);

    return result;
}

describe("StartConversation", function () {
    it("promises exactly the supported formats", async function () {
        const convertorFactory = buildConvertorFactory();

        const { formats } = await run(convertorFactory, { text: "font" });

        expect(formats).to.equal(convertorFactory.getSupportedExtensions().join(", "));
    });

    it("greets, waits and echoes the text of the next message", async function () {
        const { events } = await run(buildConvertorFactory(), { text: "font" });

        expect(events).to.deep.equal(["reply: start-conversation-welcome", "wait", "reply to next: font"]);
    });

    it("asks for text when the next message has none", async function () {
        const { events } = await run(buildConvertorFactory(), {});

        expect(events).to.deep.equal(["reply: start-conversation-welcome", "wait", "reply to next: start-conversation-not-text"]);
    });
});
