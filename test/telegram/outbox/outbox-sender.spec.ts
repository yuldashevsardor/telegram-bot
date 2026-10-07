import { expect } from "chai";
import type { Api } from "grammy";
import { GrammyError } from "grammy";
import type { TelegramApiFactory } from "app/telegram/telegram-api-factory";
import { OutboxSender } from "app/telegram/outbox/outbox-sender";
import type { OutboxJson } from "app/telegram/outbox/store/outbox-store.types";

const RESPONSE: OutboxJson = { message_id: 42 };
const API_TIMEOUT_MS = 2_500;

type ApiCall = { method: string; args: unknown[] };

// Stands for Api.raw as the sender uses it: any method by name. It answers with the response, or
// throws the error when one is set.
class FakeApi {
    public readonly calls: ApiCall[] = [];
    public error: unknown = undefined;

    public readonly raw = new Proxy(
        {},
        {
            get: (_target, method: string) => {
                return async (...args: unknown[]): Promise<OutboxJson> => {
                    this.calls.push({ method, args });

                    if (this.error !== undefined) {
                        throw this.error;
                    }

                    return RESPONSE;
                };
            },
        },
    );
}

describe("OutboxSender", function () {
    let api: FakeApi;
    // The timeout the sender asked the factory to make its Api with.
    let apiTimeoutSeconds: number | undefined;
    let sender: OutboxSender;

    beforeEach(function () {
        api = new FakeApi();
        apiTimeoutSeconds = undefined;
        const apiFactory = {
            create: (timeoutSeconds: number): Api => {
                apiTimeoutSeconds = timeoutSeconds;

                return api as unknown as Api;
            },
        };
        sender = new OutboxSender(apiFactory as unknown as TelegramApiFactory, API_TIMEOUT_MS);
    });

    it("makes its Api with the call timeout in seconds", function () {
        expect(apiTimeoutSeconds).to.equal(2.5);
    });

    it("calls the method by its name with the payload and the signal and resolves with the result", async function () {
        const payload = { chat_id: 1, text: "text" };
        const { signal } = new AbortController();

        const response = await sender.send("sendMessage", payload, signal);

        expect(response).to.equal(RESPONSE);
        expect(api.calls).to.have.lengthOf(1);
        expect(api.calls[0]?.method).to.equal("sendMessage");
        expect(api.calls[0]?.args).to.have.lengthOf(2);
        expect(api.calls[0]?.args[0]).to.equal(payload);
        expect(api.calls[0]?.args[1]).to.equal(signal);
    });

    it("throws the error of the call as it was thrown", async function () {
        const error = new GrammyError(
            "Call to 'sendMessage' failed! (400: Bad Request: chat not found)",
            { ok: false, error_code: 400, description: "Bad Request: chat not found" },
            "sendMessage",
            { chat_id: 1, text: "text" },
        );
        api.error = error;

        const thrown = await sender.send("sendMessage", { chat_id: 1, text: "text" }, new AbortController().signal).then(
            () => expect.fail("send() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(thrown).to.equal(error);
    });
});
