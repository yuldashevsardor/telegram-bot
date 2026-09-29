import { expect } from "chai";
import { GrammyError, HttpError } from "grammy";
import type { ApiError } from "grammy/types";
import { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";

const BOT_TOKEN = "123456:secret-bot-token";

describe("OutboxErrorSerializer", function () {
    const serializer = new OutboxErrorSerializer(BOT_TOKEN);

    it("keeps the stack and the fields of Telegram's answer", function () {
        const answer: ApiError = { ok: false, error_code: 400, description: "Bad Request: message text is empty", parameters: {} };
        const error = new GrammyError("Call to 'sendMessage' failed!", answer, "sendMessage", {});

        expect(serializer.serialize(error)).to.deep.equal({
            name: "GrammyError",
            message: error.message,
            stack: error.stack,
            ok: false,
            error_code: 400,
            description: "Bad Request: message text is empty",
            parameters: {},
            method: "sendMessage",
        });
    });

    it("leaves the payload of the call out", function () {
        const answer: ApiError = { ok: false, error_code: 400, description: "Bad Request: message text is empty" };
        const error = new GrammyError("Call to 'sendMessage' failed!", answer, "sendMessage", { chat_id: 1, text: "" });

        expect(serializer.serialize(error)).not.to.have.property("payload");
    });

    it("keeps a payload field of an error that is not grammY's", function () {
        const error = Object.assign(new Error("failed"), { payload: { messageId: 7 } });

        expect(serializer.serialize(error)).to.deep.include({ payload: { messageId: 7 } });
    });

    it("replaces the bot token in the error an HttpError wraps and keeps the rest of it", function () {
        const fetchError = new Error(
            `request to https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed, reason: getaddrinfo ENOTFOUND`,
        );
        const serialized = serializer.serialize(new HttpError("Network request for 'sendMessage' failed!", fetchError));

        expect(JSON.stringify(serialized)).not.to.include(BOT_TOKEN);
        expect(serialized).to.have.nested.property(
            "error.message",
            "request to https://api.telegram.org/bot***/sendMessage failed, reason: getaddrinfo ENOTFOUND",
        );
    });

    it("serializes a thrown value that is not an Error as a NonError", function () {
        expect(serializer.serialize("socket closed")).to.deep.include({ name: "NonError", message: "Non-error value: socket closed" });
    });
});
