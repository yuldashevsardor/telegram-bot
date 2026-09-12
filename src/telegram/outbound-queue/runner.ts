import { inject, injectable } from "inversify";
import { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { RunnerAlreadyRun } from "app/telegram/outbound-queue/runner.errors";
import { RunnerSettings } from "app/telegram/outbound-queue/runner.types";
import { Task } from "app/telegram/outbound-queue/task";
import { DEFAULT_RETRY_AFTER_SECONDS, TelegramApiError, TELEGRAM_ERROR_CODES } from "app/telegram/outbound-queue/telegram-error";
import { Logger } from "app/shared/logger";
import { NumberHelper } from "app/shared/number-helper";

@injectable()
export class Runner {
    private _isRun = false;

    public constructor(
        @inject<TaskQueue>(Tokens.TaskQueue.TaskQueue) private readonly taskQueue: TaskQueue,
        @inject<Logger>(Tokens.Infrastructure.Logger) private readonly logger: Logger,
        private readonly settings: RunnerSettings = configValue("runner"),
    ) {}

    public run(): void {
        if (this.isRun) {
            throw new RunnerAlreadyRun("Runner is already run.");
        }

        this._isRun = true;

        setTimeout(this.handleTasks.bind(this), 0);
    }

    public stop(): void {
        this._isRun = false;
    }

    public get isRun(): boolean {
        return this._isRun;
    }

    private handleTasks(): void {
        if (!this.isRun) {
            return;
        }

        const task = this.taskQueue.pull();

        if (!task) {
            setTimeout(this.handleTasks.bind(this), this.getSleepInterval());
            return;
        }

        // Завершения вызова цикл намеренно не ждёт: темп выдачи задают лимиты TaskQueue,
        // а не сетевая задержка Telegram. Ошибку разбирает сам handleTask.
        void this.handleTask(task);

        setTimeout(this.handleTasks.bind(this), 0);
    }

    // Сон выбирается случайно из диапазона, а не берётся фиксированным: ровный шаг раз за
    // разом попадает в одну и ту же точку окна остывания лимитов, и часть пробуждений
    // систематически приходится на занятый лимит. Случайный разводит их по окну.
    private getSleepInterval(): number {
        const { min, max } = this.settings.sleepInterval;

        return NumberHelper.generateNumber(min, max);
    }

    private async handleTask(task: Task): Promise<void> {
        try {
            await task.callback();
        } catch (error) {
            this.handleError(error);
            this.retryTask(task);
        }
    }

    private retryTask(task: Task): void {
        const retryCount = (task.retryCount ?? 0) + 1;

        if (retryCount > this.settings.maxRetries) {
            this.logger.error("Task is dropped: retry limit is reached.", {
                key: task.key,
                maxRetries: this.settings.maxRetries,
            });

            return;
        }

        this.taskQueue.push({ ...task, retryCount: retryCount }, task.priorityOnError);
    }

    private handleError(error: unknown): void {
        this.logger.error("Telegram API call is failed.", { cause: error });

        if (!Runner.isManyRequestError(error)) {
            return;
        }

        this.taskQueue.ban(Runner.getRetryAfterSeconds(error) * 1000);
    }

    // Проверяется только error_code: счесть 429 с нечитаемым parameters «не тем» типом
    // значило бы оставить настоящий 429 без паузы. Форма parameters поэтому не гарантирована —
    // getRetryAfterSeconds разбирает её, не полагаясь на тип.
    private static isManyRequestError(error: unknown): error is TelegramApiError {
        if (typeof error !== "object" || error === null || !("error_code" in error)) {
            return false;
        }

        return error.error_code === TELEGRAM_ERROR_CODES.TOO_MANY_REQUESTS;
    }

    private static getRetryAfterSeconds(error: TelegramApiError): number {
        const retryAfter = Number(error.parameters?.retry_after);

        if (!Number.isFinite(retryAfter) || retryAfter <= 0) {
            return DEFAULT_RETRY_AFTER_SECONDS;
        }

        return retryAfter;
    }
}
