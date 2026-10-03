import { GrammyError } from "grammy";
import type { ApiError, ResponseParameters } from "grammy/types";

// The error grammY throws when Telegram answers a sendMessage with ok: false. An answer without
// parameters leaves the field out, as Telegram does.
export function telegramError(errorCode: number, description: string, parameters?: ResponseParameters): GrammyError {
    const answer: ApiError = { ok: false, error_code: errorCode, description };

    if (parameters !== undefined) {
        answer.parameters = parameters;
    }

    return new GrammyError(`Call to 'sendMessage' failed! (${errorCode}: ${description})`, answer, "sendMessage", {
        chat_id: 1,
        text: "hello",
    });
}
