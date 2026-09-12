// Единственное место подсистемы, знающее про Telegram: Runner опознаёт по этим кодам ситуацию
// «слишком часто» и ставит паузу всей очереди. Когда TaskQueue/Runner понадобятся вне бота,
// отсюда вырастет стратегия обработки ошибок; заводить её под одного потребителя рано.
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

// Bot API всегда присылает retry_after вместе с 429, но если поле отсутствует или
// нечитаемо, пауза всё равно должна быть ненулевой: ban(0) истекает в момент установки.
export const DEFAULT_RETRY_AFTER_SECONDS = 1;

export type TelegramApiError = {
    error_code: number;
    parameters?: {
        retry_after?: number;
    };
};
