import { expect } from "chai";
import type { Api } from "grammy";
import { GrammyError } from "grammy";
import type { OutboxApiFactory } from "app/telegram/outbox/outbox-api-factory";
import { OutboxSender } from "app/telegram/outbox/outbox-sender";
import type { OutboxJson } from "app/telegram/outbox/store/outbox-store.types";

const RESPONSE: OutboxJson = { message_id: 42 };

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
    let sender: OutboxSender;

    beforeEach(function () {
        api = new FakeApi();
        sender = new OutboxSender({ create: () => api as unknown as Api } as unknown as OutboxApiFactory);
    });

    it("calls the method by its name with the payload alone and resolves with the result", async function () {
        const payload = { chat_id: 1, text: "text" };

        const response = await sender.send("sendMessage", payload);

        expect(response).to.equal(RESPONSE);
        expect(api.calls).to.deep.equal([{ method: "sendMessage", args: [payload] }]);
    });

    it("throws the error of the call as it was thrown", async function () {
        const error = new GrammyError(
            "Call to 'sendMessage' failed! (400: Bad Request: chat not found)",
            { ok: false, error_code: 400, description: "Bad Request: chat not found" },
            "sendMessage",
            { chat_id: 1, text: "text" },
        );
        api.error = error;

        const thrown = await sender.send("sendMessage", { chat_id: 1, text: "text" }).then(
            () => expect.fail("send() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(thrown).to.equal(error);
    });
});
