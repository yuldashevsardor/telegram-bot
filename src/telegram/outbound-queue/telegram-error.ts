// The only Telegram-specific file of the queue: by these codes Runner recognises a "too often"
// answer and pauses the whole queue. There is no error-classification interface: the queue serves
// Telegram alone, so there is nothing to substitute.
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

// The Bot API always sends retry_after with a 429. If it is missing or unreadable, the pause must
// still be non-zero: ban(0) expires the moment it is set.
export const DEFAULT_RETRY_AFTER_SECONDS = 1;

export type TelegramApiError = {
    error_code: number;
    parameters?: {
        retry_after?: number;
    };
};
