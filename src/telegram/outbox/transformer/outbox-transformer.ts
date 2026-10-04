import { inject, injectable } from "inversify";
import type { RawApi, Transformer } from "grammy";
import type { ApiError, ApiResponse, ResponseParameters } from "grammy/types";
import { Tokens } from "app/shared/tokens";
import { isGroupChat } from "app/telegram/telegram-chat";
import { isPlainObject, serialize } from "app/telegram/outbox/payload-codec/payload-codec";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxResultWaiter } from "app/telegram/outbox/result-waiter/outbox-result-waiter";
import type { FinishedOutboxMessage, OutboxAttemptError } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxPriority, OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxMessageFailed, OutboxMessageSkipped } from "app/telegram/outbox/transformer/outbox-transformer.errors";

// The answer of Telegram to a failed call, as OutboxErrorSerializer keeps the fields of a GrammyError
// in the attempt. grammY gives a GrammyError the parameters {} when the answer has none.
type TelegramErrorAnswer = {
    error_code: number;
    description: string;
    parameters: ResponseParameters;
};

// The methods a group chat calls past the outbox: Telegram does not count them towards the limit of
// the group, so they need not wait behind its messages.
const GROUP_METHODS_PAST_THE_OUTBOX = new Set<string>([
    "getChat",
    "getChatAdministrators",
    "getChatMembersCount",
    "getChatMember",
    "sendChatAction",
]);

// A GrammyError keeps the answer of Telegram; an HttpError, a lease that expired or a row that did
// not rebuild has none.
function isTelegramErrorAnswer(error: OutboxAttemptError | null): error is OutboxAttemptError & TelegramErrorAnswer {
    return (
        error !== null &&
        typeof error["error_code"] === "number" &&
        typeof error["description"] === "string" &&
        typeof error["parameters"] === "object" &&
        error["parameters"] !== null
    );
}

// Turns a Bot API call to a chat into an outbox message and gives the caller its outcome
// (docs/architecture/bot.md, "The outbox transformer").
@injectable()
export class OutboxTransformer {
    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<OutboxResultWaiter>(Tokens.Bot.Outbox.Result.Waiter) private readonly waiter: OutboxResultWaiter,
    ) {}

    // A field rather than a method: grammY calls the transformer without this. The signal of the
    // caller does not reach a queued call: the runner sends the message with a signal of its own,
    // and the message stays queued whatever the caller does.
    public readonly transform: Transformer<RawApi> = async (prev, method, payload, signal) => {
        const chatId = this.findQueuedChatId(method, payload);

        if (chatId === undefined) {
            return prev(method, payload, signal);
        }

        const messageId = await this.store.push({
            chatId: chatId,
            method: method,
            payload: serialize(method, payload),
            priority: OutboxPriority.Call,
        });

        return this.toResponse(await this.waiter.wait(messageId), method);
    };

    // The chat a call is queued for, or undefined for a call that goes straight to Telegram: one
    // without a chat, one to a chat named by its username, and a group call Telegram does not limit.
    // Only a plain object is queued: serialize() takes nothing else for a payload, and grammY builds
    // its payloads as literals.
    private findQueuedChatId(method: string, payload: unknown): number | undefined {
        if (!isPlainObject(payload) || !("chat_id" in payload)) {
            return undefined;
        }

        const chatId = Number(payload["chat_id"]);

        if (isNaN(chatId) || (isGroupChat(chatId) && GROUP_METHODS_PAST_THE_OUTBOX.has(method))) {
            return undefined;
        }

        return chatId;
    }

    // grammY throws the GrammyError itself on an answer with ok: false, as for a call it sent. The
    // result of a done message is the result Telegram gave for this method; the row does not carry
    // its type, hence never.
    private toResponse(message: FinishedOutboxMessage, method: string): ApiResponse<never> {
        switch (message.status) {
            case OutboxStatus.Done:
                return { ok: true, result: message.response as never };
            case OutboxStatus.Failed:
                return this.toErrorAnswer(message, method);
            case OutboxStatus.Skipped:
                throw OutboxMessageSkipped.of(message.id, method);
        }
    }

    private toErrorAnswer(message: FinishedOutboxMessage, method: string): ApiError {
        const { error } = message;

        if (!isTelegramErrorAnswer(error)) {
            throw OutboxMessageFailed.of(message.id, method, error);
        }

        return { ok: false, error_code: error.error_code, description: error.description, parameters: error.parameters };
    }
}
