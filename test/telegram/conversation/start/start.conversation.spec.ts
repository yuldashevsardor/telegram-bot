import "reflect-metadata";
import { expect } from "chai";
import type { Message } from "@grammyjs/types";
import { createConversation } from "@grammyjs/conversations";
import type { Context, Conversation } from "app/telegram/bot/bot.types";
import { StartConversation } from "app/telegram/conversation/start/start.conversation";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import { WoffFontValidator } from "app/font-convertor/validator/woff/woff-font-validator";
import { Woff2FontValidator } from "app/font-convertor/validator/woff2/woff2-font-validator";
import { EotFontValidator } from "app/font-convertor/validator/eot/eot-font-validator";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";

type Run = { formats: unknown; events: string[] };

function buildConvertorFactory(): ConvertorFactory {
    return new ConvertorFactory(
        {} as FontForge,
        new FontValidatorResolver(
            new SvgFontValidator(),
            new WoffFontValidator(new SfntFontValidator()),
            new Woff2FontValidator(new SfntFontValidator()),
            new SfntFontValidator(),
            new EotFontValidator(new SfntFontValidator(), new EotPayloadDecoder()),
        ),
        new EotPacker(new EotPayloadDecoder()),
    );
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
    // Bot.setup() registers the conversation in the plugin under its name, and without a name the plugin refuses.
    it("registers in the conversations plugin under its name", function () {
        const handler = new StartConversation(buildConvertorFactory());

        expect(() => createConversation(handler.handle.bind(handler), handler.name)).to.not.throw();
    });

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
