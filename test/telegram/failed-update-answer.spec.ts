import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import type { Update } from "@grammyjs/types";
import type { Fluent } from "@moebius/fluent";
import { FailedUpdateAnswer } from "app/telegram/failed-update-answer/failed-update-answer";
import { createFluent } from "app/telegram/locale/locale";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxMessageInput } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxPriority } from "app/telegram/outbox/store/outbox-store.types";

const CHAT = 5_000_000_001;
const GROUP_CHAT = -1_000_000_001;
const CONTACT = "@author";

describe("FailedUpdateAnswer", function () {
    let fluent: Fluent;
    let pushed: OutboxMessageInput[];
    let answer: FailedUpdateAnswer;

    before(async function () {
        fluent = await createFluent(path.resolve(__dirname, "../../src/telegram"));
    });

    beforeEach(function () {
        pushed = [];
        const store = {
            push: async (message: OutboxMessageInput): Promise<number> => {
                pushed.push(message);

                return pushed.length;
            },
        } as unknown as OutboxStore;
        answer = new FailedUpdateAnswer(store, fluent, CONTACT);
    });

    it("pushes the answer into the outbox for the chat of the update, with the priority of a call", async function () {
        await answer.send(CHAT, messageUpdate("ru"));

        expect(pushed).to.deep.equal([
            {
                chatId: CHAT,
                method: "sendMessage",
                payload: {
                    chat_id: CHAT,
                    text: "Что-то пошло не так. Попробуйте ещё раз чуть позже. Если не пройдёт — напишите автору: @author.",
                },
                priority: OutboxPriority.Call,
            },
        ]);
    });

    it("answers in the language of the sender", async function () {
        await answer.send(CHAT, messageUpdate("en-US"));

        expect(pushed.map(({ payload }) => payload["text"])).to.deep.equal([
            "Something went wrong. Please try again a bit later. If it still fails, write to the author: @author.",
        ]);
    });

    it("answers in the default locale a sender without a language", async function () {
        await answer.send(CHAT, messageUpdate(undefined));

        expect(pushed.map(({ payload }) => payload["text"])).to.deep.equal([
            fluent.withLocale(DEFAULT_LOCALE)("failed-update-answer-text", { contact: CONTACT }),
        ]);
    });

    it("says nothing in a group chat, where the bot does not talk", async function () {
        await answer.send(GROUP_CHAT, messageUpdate("ru"));

        expect(pushed).to.deep.equal([]);
    });

    // A button press comes as a callback query, whose sender is not under message: the sender is read
    // as the pipeline reads ctx.from.
    it("reads the sender of an update that is not a message", async function () {
        const update: Update = {
            update_id: 1,
            callback_query: {
                id: "1",
                chat_instance: "1",
                from: { id: CHAT, is_bot: false, first_name: "User", language_code: "en" },
                data: "ttf",
            },
        };

        await answer.send(CHAT, update);

        expect(pushed.map(({ payload }) => payload["text"])).to.deep.equal([
            fluent.withLocale("en")("failed-update-answer-text", { contact: CONTACT }),
        ]);
    });
});

// A private message of the chat's user, with the language code Telegram gives the sender.
function messageUpdate(languageCode: string | undefined): Update {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            date: 0,
            chat: { id: CHAT, type: "private", first_name: "User" },
            from: {
                id: CHAT,
                is_bot: false,
                first_name: "User",
                ...(languageCode === undefined ? {} : { language_code: languageCode }),
            },
            text: "text",
        },
    };
}
