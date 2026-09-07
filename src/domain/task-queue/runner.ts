import { inject, injectable } from "inversify";
import { TaskQueue } from "app/domain/task-queue/task-queue";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { RunnerAlreadyRun } from "app/domain/task-queue/runner.errors";
import { RunnerSettings } from "app/domain/task-queue/runner.types";
import { Task } from "app/domain/task-queue/task";
import { DEFAULT_RETRY_AFTER_SECONDS, TelegramApiError, TELEGRAM_ERROR_CODES } from "app/domain/task-queue/telegram-error";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";
import { Logger } from "app/domain/logger/logger";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";

@injectable()
export class Runner {
    @ConfigValue<RunnerSettings>("runner")
    private readonly settings!: RunnerSettings;

    private _isRun = false;

    public constructor(
        @inject<TaskQueue>(Modules.TaskQueue.TaskQueue) private readonly taskQueue: TaskQueue,
        @inject<Logger>(Infrastructure.Logger) private readonly logger: Logger,
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
            setTimeout(this.handleTasks.bind(this), this.settings.sleepInterval);
            return;
        }

        // Завершения вызова цикл намеренно не ждёт: темп выдачи задают лимиты TaskQueue,
        // а не сетевая задержка Telegram. Ошибку разбирает сам handleTask.
        void this.handleTask(task);

        setTimeout(this.handleTasks.bind(this), 0);
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
        this.logger.error("Telegram API call is failed.", { error: error });

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

        return error.error_code === TELEGRAM_ERROR_CODES.TO_MANY_REQUESTS;
    }

    private static getRetryAfterSeconds(error: TelegramApiError): number {
        const retryAfter = Number(error.parameters?.retry_after);

        if (!Number.isFinite(retryAfter) || retryAfter <= 0) {
            return DEFAULT_RETRY_AFTER_SECONDS;
        }

        return retryAfter;
    }
}
