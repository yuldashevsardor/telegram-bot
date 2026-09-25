import { inject, injectable } from "inversify";
import type { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { RunnerAlreadyRun } from "app/telegram/outbound-queue/runner/runner.errors";
import type { RunnerSettings } from "app/telegram/outbound-queue/runner/runner.types";
import type { Task } from "app/telegram/outbound-queue/task";
import type { TelegramApiError } from "app/telegram/outbound-queue/telegram-error";
import { DEFAULT_RETRY_AFTER_SECONDS, TELEGRAM_ERROR_CODES } from "app/telegram/outbound-queue/telegram-error";
import type { Logger } from "app/platform/logger/logger";
import { NumberHelper } from "app/shared/number-helper";

@injectable()
export class Runner {
    private _isRun = false;

    public constructor(
        @inject<TaskQueue>(Tokens.Bot.OutboundQueue.TaskQueue) private readonly taskQueue: TaskQueue,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
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

        // The loop does not wait for the call on purpose: the pace is set by the limits of TaskQueue,
        // not by the network latency of Telegram. handleTask handles the error itself.
        void this.handleTask(task);

        setTimeout(this.handleTasks.bind(this), 0);
    }

    // A random sleep, not a fixed one: an even step hits the same point of the cooldown window every
    // time, so some wake-ups keep landing on a busy limit. A random step spreads them across the window.
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

    // Only error_code is checked: rejecting a 429 with unreadable parameters as the wrong type would
    // leave a real 429 without a pause. So the shape of parameters is not guaranteed, and
    // getRetryAfterSeconds parses it without relying on the type.
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
