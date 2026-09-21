// The only place in the queue mechanism that knows about Telegram: by these codes Runner
// recognises a "too often" answer and pauses the whole queue. No error-classification interface is
// kept for that: the queue serves Telegram alone, and there is nothing here to substitute.
export enum TELEGRAM_ERROR_CODES {
    /**
     *  response: {
     *     ok: false,
     *     error_code: 429,
     *     description: 'Too Many Requests: retry after 60',
     *     parameters: { retry_after: 60 }
     *   },
     *   on: {
     *     method: 'sendMessage',
     *     payload: { chat_id: 123, text: 'Some text' }
     *   }
     */
    TOO_MANY_REQUESTS = 429,
}

// The Bot API always sends retry_after together with a 429, but if the field is missing or
// unreadable the pause still has to be non-zero: ban(0) expires the moment it is set.
export const DEFAULT_RETRY_AFTER_SECONDS = 1;

export type TelegramApiError = {
    error_code: number;
    parameters?: {
        retry_after?: number;
    };
};
