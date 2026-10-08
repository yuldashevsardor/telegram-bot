import "reflect-metadata";
import { expect } from "chai";
import type { RawApi, Transformer } from "grammy";
import { Api, GrammyError, InputFile } from "grammy";
import { RuntimeError } from "app/shared/errors";
import { PathFile } from "app/telegram/path-file/path-file";
import { OutboxTransformer } from "app/telegram/outbox/transformer/outbox-transformer";
import { OutboxMessageFailed, OutboxMessageSkipped } from "app/telegram/outbox/transformer/outbox-transformer.errors";
import { OutboxResultTimeout } from "app/telegram/outbox/result-waiter/outbox-result-waiter.errors";
import { UnsupportedInputFile } from "app/telegram/outbox/payload-codec/payload-codec.errors";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxResultWaiter } from "app/telegram/outbox/result-waiter/outbox-result-waiter";
import type { FinishedOutboxMessage, OutboxMessageInput } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxPriority, OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { caught } from "test/shared/utils.helper";

type TelegramCall = { method: string; payload: unknown; signal: unknown };

const PRIVATE_CHAT_ID = 111;
const GROUP_CHAT_ID = -100111;
const MESSAGE_ID = 7;
const SENT = { message_id: 1, date: 0, chat: { id: PRIVATE_CHAT_ID, type: "private" }, text: "text" };

// An outbox that gives every pushed message the id MESSAGE_ID and the outcome set in the test.
class FakeOutbox {
    public readonly pushed: OutboxMessageInput[] = [];
    public readonly waitedIds: number[] = [];
    public pushFailure: Error | undefined = undefined;
    public outcome: Promise<FinishedOutboxMessage> = Promise.resolve(done(SENT));

    public async push(message: OutboxMessageInput): Promise<number> {
        if (this.pushFailure !== undefined) {
            throw this.pushFailure;
        }

        this.pushed.push(message);

        return MESSAGE_ID;
    }

    public wait(messageId: number): Promise<FinishedOutboxMessage> {
        this.waitedIds.push(messageId);

        return this.outcome;
    }
}

type Setup = { api: Api; outbox: FakeOutbox; telegramCalls: TelegramCall[] };

// A real Api of grammY: the fake Telegram is the transformer under the one of the outbox, as the
// network is under every transformer.
function setup(): Setup {
    const outbox = new FakeOutbox();
    const telegramCalls: TelegramCall[] = [];
    const api = new Api("test-token");
    const telegram: Transformer<RawApi> = async (_prev, method, payload, signal) => {
        telegramCalls.push({ method: method, payload: payload, signal: signal });

        return { ok: true, result: `${method} result` } as never;
    };
    const transformer = new OutboxTransformer(outbox as unknown as OutboxStore, outbox as unknown as OutboxResultWaiter);

    api.config.use(telegram);
    api.config.use(transformer.transform);

    return { api: api, outbox: outbox, telegramCalls: telegramCalls };
}

function done(response: object): FinishedOutboxMessage {
    return { id: MESSAGE_ID, status: OutboxStatus.Done, response: response as FinishedOutboxMessage["response"], error: null };
}

function failed(error: FinishedOutboxMessage["error"]): FinishedOutboxMessage {
    return { id: MESSAGE_ID, status: OutboxStatus.Failed, response: null, error: error };
}

describe("OutboxTransformer", function () {
    describe("a call to a chat", function () {
        it("is pushed with its payload stored and resolves to the result of its message, without reaching Telegram", async function () {
            const { api, outbox, telegramCalls } = setup();

            const sent = await api.raw.sendMessage({ chat_id: PRIVATE_CHAT_ID, text: "text" });

            expect(sent).to.deep.equal(SENT);
            expect(outbox.pushed).to.deep.equal([
                {
                    chatId: PRIVATE_CHAT_ID,
                    method: "sendMessage",
                    payload: { chat_id: PRIVATE_CHAT_ID, text: "text" },
                    priority: OutboxPriority.Call,
                },
            ]);
            expect(outbox.waitedIds).to.deep.equal([MESSAGE_ID]);
            expect(telegramCalls).to.have.lengthOf(0);
        });

        it("is pushed for a group chat outside the methods Telegram does not limit there", async function () {
            const { api, outbox, telegramCalls } = setup();

            await api.sendMessage(GROUP_CHAT_ID, "text");

            expect(outbox.pushed.map((message) => message.chatId)).to.deep.equal([GROUP_CHAT_ID]);
            expect(telegramCalls).to.have.lengthOf(0);
        });

        it("is pushed for such a method in a private chat", async function () {
            const { api, outbox, telegramCalls } = setup();

            await api.sendChatAction(PRIVATE_CHAT_ID, "typing");

            expect(outbox.pushed.map((message) => message.method)).to.deep.equal(["sendChatAction"]);
            expect(telegramCalls).to.have.lengthOf(0);
        });

        it("takes a chat id given as a string of digits as the number", async function () {
            const { api, outbox } = setup();

            await api.sendMessage(String(PRIVATE_CHAT_ID), "text");

            expect(outbox.pushed.map((message) => message.chatId)).to.deep.equal([PRIVATE_CHAT_ID]);
        });

        it("stores a file by its path", async function () {
            const { api, outbox } = setup();

            await api.sendDocument(PRIVATE_CHAT_ID, new PathFile("/shared/font.ttf"));

            expect(outbox.pushed[0]?.payload).to.deep.equal({
                chat_id: PRIVATE_CHAT_ID,
                document: { $pathFile: { path: "/shared/font.ttf", filename: "font.ttf" } },
            });
        });

        it("rejects a file another node cannot read and pushes nothing", async function () {
            const { api, outbox, telegramCalls } = setup();

            const error = await caught(api.sendDocument(PRIVATE_CHAT_ID, new InputFile(Buffer.from("font"))));

            expect(error).to.be.instanceOf(UnsupportedInputFile);
            expect(outbox.pushed).to.have.lengthOf(0);
            expect(telegramCalls).to.have.lengthOf(0);
        });

        it("rejects with the error of the push and waits for nothing", async function () {
            const { api, outbox } = setup();
            const pushFailure = new RuntimeError("database is down");
            outbox.pushFailure = pushFailure;

            expect(await caught(api.sendMessage(PRIVATE_CHAT_ID, "text"))).to.equal(pushFailure);
            expect(outbox.waitedIds).to.have.lengthOf(0);
        });
    });

    describe("the outcome of a message that was not sent", function () {
        // The transformer reads back what OutboxErrorSerializer keeps of a GrammyError: a field the
        // serializer stops keeping would turn every such failure into OutboxMessageFailed.
        it("rejects with the GrammyError the serializer kept in the attempt", async function () {
            const { api, outbox } = setup();
            const sendFailure = new GrammyError(
                "Call to 'sendMessage' failed!",
                { ok: false, error_code: 400, description: "Bad Request: chat not found", parameters: { retry_after: 3 } },
                "sendMessage",
                { chat_id: PRIVATE_CHAT_ID, text: "text" },
            );
            const attemptError = {
                ...new OutboxErrorSerializer("test-token").serialize(sendFailure),
                kind: TelegramBotApiFailureKind.Undeliverable,
            };
            outbox.outcome = Promise.resolve(failed(attemptError));

            const error = await caught(api.sendMessage(PRIVATE_CHAT_ID, "text"));

            expect(error).to.be.instanceOf(GrammyError);
            expect(error).to.deep.include({
                error_code: 400,
                description: "Bad Request: chat not found",
                parameters: { retry_after: 3 },
            });
        });

        // grammY builds the GrammyError itself, from the answer the transformer gives back.
        it("rejects with a GrammyError of the answer Telegram gave its last attempt", async function () {
            const { api, outbox } = setup();
            outbox.outcome = Promise.resolve(
                failed({
                    name: "GrammyError",
                    error_code: 403,
                    description: "Forbidden: bot was blocked by the user",
                    parameters: {},
                    kind: TelegramBotApiFailureKind.Undeliverable,
                }),
            );

            const error = await caught(api.sendMessage(PRIVATE_CHAT_ID, "text"));

            expect(error).to.be.instanceOf(GrammyError);
            expect(error).to.deep.include({
                method: "sendMessage",
                error_code: 403,
                description: "Forbidden: bot was blocked by the user",
                parameters: {},
            });
        });

        it("keeps the parameters of the answer", async function () {
            const { api, outbox } = setup();
            outbox.outcome = Promise.resolve(
                failed({
                    error_code: 400,
                    description: "Bad Request: group chat was upgraded to a supergroup chat",
                    parameters: { migrate_to_chat_id: -1001 },
                    kind: TelegramBotApiFailureKind.Undeliverable,
                }),
            );

            const error = await caught(api.sendMessage(PRIVATE_CHAT_ID, "text"));

            expect((error as GrammyError).parameters).to.deep.equal({ migrate_to_chat_id: -1001 });
        });

        const notAnswers: Array<{ name: string; error: FinishedOutboxMessage["error"] }> = [
            {
                name: "an error without an answer of Telegram",
                error: { name: "HttpError", message: "Network request failed", kind: TelegramBotApiFailureKind.Transient },
            },
            { name: "no error code", error: { description: "Forbidden", parameters: {}, kind: TelegramBotApiFailureKind.Unexpected } },
            { name: "no description", error: { error_code: 403, parameters: {}, kind: TelegramBotApiFailureKind.Unexpected } },
            { name: "no parameters", error: { error_code: 403, description: "Forbidden", kind: TelegramBotApiFailureKind.Unexpected } },
            {
                name: "null parameters",
                error: { error_code: 403, description: "Forbidden", parameters: null, kind: TelegramBotApiFailureKind.Unexpected },
            },
            { name: "no error at all", error: null },
        ];

        for (const { name, error: attemptError } of notAnswers) {
            it(`rejects with OutboxMessageFailed for a failed message whose last attempt has ${name}`, async function () {
                const { api, outbox } = setup();
                outbox.outcome = Promise.resolve(failed(attemptError));

                const error = await caught(api.sendMessage(PRIVATE_CHAT_ID, "text"));

                expect(error).to.be.instanceOf(OutboxMessageFailed);
                expect((error as OutboxMessageFailed).payload).to.deep.equal({
                    messageId: MESSAGE_ID,
                    method: "sendMessage",
                    attemptError: attemptError,
                });
            });
        }

        it("rejects with OutboxMessageSkipped for a skipped message", async function () {
            const { api, outbox } = setup();
            outbox.outcome = Promise.resolve({ id: MESSAGE_ID, status: OutboxStatus.Skipped, response: null, error: null });

            const error = await caught(api.sendMessage(PRIVATE_CHAT_ID, "text"));

            expect(error).to.be.instanceOf(OutboxMessageSkipped);
            expect((error as OutboxMessageSkipped).payload).to.deep.equal({ messageId: MESSAGE_ID, method: "sendMessage" });
        });

        // The message stays queued and may still go out: only the wait is over.
        it("rejects with the timeout of the wait", async function () {
            const { api, outbox } = setup();
            const timeout = OutboxResultTimeout.of(MESSAGE_ID, 1);
            outbox.outcome = Promise.reject(timeout);

            expect(await caught(api.sendMessage(PRIVATE_CHAT_ID, "text"))).to.equal(timeout);
        });
    });

    describe("goes straight to Telegram", function () {
        async function expectDirect(call: (api: Api) => Promise<unknown>, method: string): Promise<void> {
            const { api, outbox, telegramCalls } = setup();

            expect(await call(api)).to.equal(`${method} result`);
            expect(outbox.pushed).to.have.lengthOf(0);
            expect(telegramCalls.map((telegramCall) => telegramCall.method)).to.deep.equal([method]);
        }

        it("without chat_id", async function () {
            await expectDirect((api) => api.getFile("file-id"), "getFile");
        });

        it("with a chat_id that is not a number", async function () {
            await expectDirect((api) => api.sendMessage("@channel", "text"), "sendMessage");
        });

        for (const method of ["getChat", "getChatAdministrators", "getChatMembersCount", "getChatMember", "sendChatAction"] as const) {
            it(`for ${method} in a group chat`, async function () {
                const call = (api: Api): Promise<unknown> =>
                    (api.raw[method] as (payload: object) => Promise<unknown>)({ chat_id: GROUP_CHAT_ID });

                await expectDirect(call, method);
            });
        }

        // The service calls of the bot: none carries a chat.
        it("for the service calls", async function () {
            const { api, outbox, telegramCalls } = setup();

            await api.getMe();
            await api.setMyCommands([{ command: "start", description: "Start" }]);
            await api.getUpdates({ timeout: 0 });
            await api.setWebhook("https://example.com/hook");
            await api.deleteWebhook();

            expect(outbox.pushed).to.have.lengthOf(0);
            expect(telegramCalls.map((telegramCall) => telegramCall.method)).to.deep.equal([
                "getMe",
                "setMyCommands",
                "getUpdates",
                "setWebhook",
                "deleteWebhook",
            ]);
        });

        it("for a raw call without a payload", async function () {
            await expectDirect((api) => api.raw.getMe(), "getMe");
        });

        it("with a payload that is not a plain object", async function () {
            class Payload {
                public readonly chat_id = PRIVATE_CHAT_ID;
                public readonly text = "text";
            }

            await expectDirect((api) => api.raw.sendMessage(new Payload()), "sendMessage");
        });

        it("with the signal of the caller", async function () {
            const { api, telegramCalls } = setup();
            // AbortSignal in the grammY types comes from the abort-controller shim and does not match the global one.
            const signal = new AbortController().signal as Parameters<Api["getMe"]>[0];

            await api.getMe(signal);

            expect(telegramCalls).to.deep.equal([{ method: "getMe", payload: {}, signal: signal }]);
        });
    });
});
