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
    TO_MANY_REQUESTS = 429,
}

// Bot API всегда присылает retry_after вместе с 429, но если поле отсутствует или
// нечитаемо, бан всё равно должен быть ненулевым: ban(0) истекает в момент установки.
export const DEFAULT_RETRY_AFTER_SECONDS = 1;

export enum PRIORITY {
    HIGH = "HIGH",
    MEDIUM = "MEDIUM",
    LOW = "LOW",
}

export type BrokerSettings = {
    sleepInterval: number;
    maxRetries: number;
};

export type TelegramApiError = {
    error_code: number;
};

export type Message = {
    chatId: number;
    isGroup: boolean;
    priorityOnError: PRIORITY;
    callback: () => Promise<unknown>;
    retryCount?: number;
};
