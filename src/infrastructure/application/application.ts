import { container } from "app/infrastructure/container/container";
import { ApplicationContext } from "app/infrastructure/application/application-context";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { Database } from "app/infrastructure/database/database";
import { Runner } from "app/domain/task-queue/runner";
import { TaskQueue } from "app/domain/task-queue/task-queue";
import { Bot } from "app/infrastructure/bot/bot";
import { sleep, withTimeout } from "app/helper/utils";
import { RuntimeError } from "app/common/errors";

export class Application {
    private context!: ApplicationContext;
    private taskQueue!: TaskQueue;
    private runner!: Runner;
    private bot!: Bot;

    private isSetup = false;
    private isRun = false;

    public async setup(): Promise<void> {
        if (this.isSetup) {
            return;
        }

        this.context = ApplicationContext.create();

        this.context.logger.info("Setup container...");

        await container.setup(this.context);

        this.context.logger.info("Container successfully setup.");
        this.context.logger.info("Check database connection...");

        await container.get<Database>(Infrastructure.Database).check();

        this.context.logger.info("Database connection is alive.");

        this.taskQueue = container.get<TaskQueue>(Modules.TaskQueue.TaskQueue);
        this.runner = container.get<Runner>(Modules.TaskQueue.Runner);
        this.bot = container.get<Bot>(Modules.Bot.Bot);

        await this.bot.setup();

        this.isSetup = true;
    }

    public async run(): Promise<void> {
        if (!this.isSetup) {
            throw new RuntimeError("Application is not set up!");
        }

        try {
            await this.runner.run();
            await this.bot.run();

            this.isRun = true;

            this.context.logger.info("Application is successfully started.");
        } catch (error) {
            this.runner.stop();

            this.context.logger.critical("Unhandled error on application start", { error: error });

            throw error;
        }
    }

    public async stop(): Promise<void> {
        if (!this.isSetup) {
            return;
        }

        this.context.logger.info("Stop application...");

        const { timeout } = this.context.config.gracefulShutdown;

        if (!(await withTimeout(this.shutdown(), timeout))) {
            this.context.logger.warning("Graceful shutdown timeout is over, the shutdown was cut short.", {
                timeout: timeout,
            });

            return;
        }

        this.context.logger.info("Application is successfully stopped.");
    }

    // Свой срок есть у каждого шага, а общий — у остановки целиком: он больше их суммы
    // (проверяется при сборке конфига), поэтому на остановку брокера и закрытие пула время
    // остаётся даже тогда, когда бот и очередь выбрали своё до конца.
    private async shutdown(): Promise<void> {
        if (this.isRun) {
            await this.bot.stop();
            await this.waitQueueToEmpty();
            await this.runner.stop();

            this.isRun = false;
        }

        await container.close();
    }

    private async waitQueueToEmpty(): Promise<void> {
        const { timeout, interval } = this.context.config.taskQueue.gracefulShutdown;
        const deadline = Date.now() + timeout;

        while (!this.taskQueue.isEmpty()) {
            const timeLeft = deadline - Date.now();

            if (timeLeft <= 0) {
                this.context.logger.warning("Shutdown timeout is over, remaining tasks will not be done.", {
                    tasksLeft: this.taskQueue.getTaskCount(),
                    timeout: timeout,
                });

                return;
            }

            this.context.logger.info(`Waiting for the outgoing queue to empty: ${this.taskQueue.getTaskCount()} tasks left.`);

            await sleep(Math.min(interval, timeLeft));
        }
    }
}
