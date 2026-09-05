import { inject, injectable } from "inversify";
import { Planner } from "app/domain/planner/planner";
import { Modules } from "app/infrastructure/container/symbols/modules";
import {
    BrokerSettings,
    DEFAULT_RETRY_AFTER_SECONDS,
    Message,
    TelegramApiError,
    TELEGRAM_ERROR_CODES,
} from "app/domain/broker/broker.types";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";
import { Logger } from "app/domain/logger/logger";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";

@injectable()
export class Broker {
    @ConfigValue<BrokerSettings>("broker")
    private readonly settings!: BrokerSettings;

    private _isRun = false;

    public constructor(
        @inject<Planner>(Modules.Planner.Planner) private readonly planner: Planner,
        @inject<Logger>(Infrastructure.Logger) private readonly logger: Logger,
    ) {}

    public run(): void {
        if (this.isRun) {
            throw new Error("broker already is run.");
        }

        this._isRun = true;

        setTimeout(this.handleMessages.bind(this), 0);
    }

    public stop(): void {
        this._isRun = false;
    }

    public get isRun(): boolean {
        return this._isRun;
    }

    private handleMessages(): void {
        if (!this.isRun) {
            return;
        }

        const message = this.planner.pull();

        if (!message) {
            setTimeout(this.handleMessages.bind(this), this.settings.sleepInterval);
            return;
        }

        // Завершения вызова цикл намеренно не ждёт: темп выдачи задают слоты Planner,
        // а не сетевая задержка Telegram. Ошибку разбирает сам handleMessage.
        void this.handleMessage(message);

        setTimeout(this.handleMessages.bind(this), 0);
    }

    private async handleMessage(message: Message): Promise<void> {
        try {
            await message.callback();
        } catch (error) {
            this.handleError(error);
            this.retryMessage(message);
        }
    }

    private retryMessage(message: Message): void {
        const retryCount = (message.retryCount ?? 0) + 1;

        if (retryCount > this.settings.maxRetries) {
            this.logger.error("Message is dropped: retry limit is reached.", {
                chatId: message.chatId,
                maxRetries: this.settings.maxRetries,
            });

            return;
        }

        this.planner.push({ ...message, retryCount: retryCount }, message.priorityOnError);
    }

    private handleError(error: unknown): void {
        this.logger.error("Telegram API call is failed.", { error: error });

        if (!Broker.isManyRequestError(error)) {
            return;
        }

        this.planner.ban(Broker.getRetryAfterSeconds(error) * 1000);
    }

    private static isManyRequestError(error: unknown): error is TelegramApiError {
        if (typeof error !== "object" || error === null || !("error_code" in error)) {
            return false;
        }

        return error.error_code === TELEGRAM_ERROR_CODES.TO_MANY_REQUESTS;
    }

    private static getRetryAfterSeconds(error: unknown): number {
        if (typeof error !== "object" || error === null || !("parameters" in error)) {
            return DEFAULT_RETRY_AFTER_SECONDS;
        }

        const parameters = error.parameters;

        if (typeof parameters !== "object" || parameters === null || !("retry_after" in parameters)) {
            return DEFAULT_RETRY_AFTER_SECONDS;
        }

        const retryAfter = Number(parameters.retry_after);

        if (!Number.isFinite(retryAfter) || retryAfter <= 0) {
            return DEFAULT_RETRY_AFTER_SECONDS;
        }

        return retryAfter;
    }
}
