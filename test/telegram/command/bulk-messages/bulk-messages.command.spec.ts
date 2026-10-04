import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import { Api, Composer, Context as GrammyContext } from "grammy";
import type { Update, UserFromGetMe } from "@grammyjs/types";
import type { Context } from "app/telegram/bot/bot.types";
import { RuntimeError } from "app/shared/errors";
import { BulkMessagesCommand } from "app/telegram/command/bulk-messages/bulk-messages.command";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxMessageInput } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxPriority } from "app/telegram/outbox/store/outbox-store.types";
import { createFluent } from "app/telegram/locale/locale";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";

const CHATS = [2815426, 5067823410, 858262157];

const ME = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;

function commandUpdate(text: string): Update {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            date: 0,
            chat: { id: 1, type: "private", first_name: "User" },
            from: { id: 1, is_bot: false, first_name: "User" },
            text: text,
            entities: [{ type: "bot_command", offset: 0, length: text.length }],
        },
    };
}

// Records the batches; every batch fails while failure is set.
class RecordingStore {
    public readonly batches: OutboxMessageInput[][] = [];
    public failure: Error | undefined = undefined;

    public async pushBatch(messages: OutboxMessageInput[]): Promise<number[]> {
        if (this.failure !== undefined) {
            throw this.failure;
        }

        this.batches.push(messages);

        return messages.map((_message, index) => index + 1);
    }
}

type Run = { store: RecordingStore; logger: RecordingLogger; caught: unknown };

// The update goes through setup(), as in Bot: the command has to answer to its own name.
async function run(failure?: Error): Promise<Run> {
    const store = new RecordingStore();
    store.failure = failure;
    const logger = new RecordingLogger();
    const ctx = new GrammyContext(commandUpdate("/bulk_messages"), new Api("test-token"), ME) as Context;
    const composer = new Composer<Context>();
    new BulkMessagesCommand(store as unknown as OutboxStore, logger).setup(composer);

    const middleware = composer.middleware();
    const caught = await Promise.resolve(middleware(ctx, () => Promise.resolve())).then(
        () => undefined,
        (error: unknown) => error,
    );

    return { store: store, logger: logger, caught: caught };
}

describe("BulkMessagesCommand", function () {
    describe("when the outbox takes the batches", function () {
        let result: Run;

        before(async function () {
            result = await run();
        });

        it("pushes 10 000 messages in batches of 1000", function () {
            expect(result.store.batches.map((batch) => batch.length)).to.deep.equal(new Array(10).fill(1000));
        });

        it("gives the chats the messages in turn", function () {
            const chatIds = result.store.batches.flat().map((message) => message.chatId);

            expect(chatIds.slice(0, 4)).to.deep.equal([CHATS[0], CHATS[1], CHATS[2], CHATS[0]]);
            expect(chatIds.slice(-1)).to.deep.equal([CHATS[(10_000 - 1) % CHATS.length]]);
        });

        it("pushes each as a sendMessage of a random text of 1000 characters to its chat, below the calls of the bot API", function () {
            const messages = result.store.batches.flat();

            for (const message of messages) {
                expect(message.method).to.equal("sendMessage");
                expect(message.priority).to.equal(OutboxPriority.Bulk);
                expect(message.payload["chat_id"]).to.equal(message.chatId);
                expect(message.payload["text"]).to.match(/^[A-Za-z0-9]{1000}$/);
            }

            expect(new Set(messages.map((message) => message.payload["text"])).size).to.be.greaterThan(1);
            expect(OutboxPriority.Bulk).to.be.greaterThan(OutboxPriority.Call);
        });

        it("logs once everything is pushed", function () {
            expect(result.logger.infos).to.deep.equal([
                { message: "Bulk messages are pushed to the outbox.", payload: { messageCount: 10_000 } },
            ]);
        });
    });

    it("rejects without logging when the outbox refuses a batch", async function () {
        const error = new RuntimeError("database is down");

        const { store, logger, caught } = await run(error);

        expect(caught).to.equal(error);
        expect(store.batches).to.have.lengthOf(0);
        expect(logger.infos).to.have.lengthOf(0);
    });

    // Bot translates descriptionKey for the command menu, and Fluent gives back `{key}` for a key
    // without a translation. A key missing in one locale only: locale.spec.ts, "declares the same
    // keys in every locale".
    it("has a translated description for the command menu", async function () {
        const fluent = await createFluent(path.join(process.cwd(), "src", "telegram"));
        const { descriptionKey } = new BulkMessagesCommand(new RecordingStore() as unknown as OutboxStore, new RecordingLogger());

        expect(fluent.translate(DEFAULT_LOCALE, descriptionKey)).to.not.equal(`{${descriptionKey}}`);
    });
});
