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
