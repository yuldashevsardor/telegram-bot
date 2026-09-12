import { container } from "app/bootstrap/container/container";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ConfigContainer } from "app/bootstrap/config-container";
import { Logger } from "app/shared/logger";
import { Tokens } from "app/shared/tokens";
import { Database } from "app/platform/database/database";
import { Runner } from "app/telegram/outbound-queue/runner";
import { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { Bot } from "app/telegram/bot";
import { sleep, withTimeout } from "app/shared/utils";
import { RuntimeError } from "app/shared/errors";

export class Application {
    private cc!: ConfigContainer;
    private logger!: Logger;
    private taskQueue!: TaskQueue;
    private runner!: Runner;
    private bot!: Bot;

    private isSetup = false;
    private isRun = false;

    public async setup(): Promise<void> {
        if (this.isSetup) {
            return;
        }

        ApplicationContext.create();

        this.cc = ApplicationContext.getConfigContainer();
        this.logger = ApplicationContext.getLogger();

        this.logger.info("Setup container...");

        await container.setup();

        this.logger.info("Container successfully setup.");
        this.logger.info("Check database connection...");

        await container.get<Database>(Tokens.Infrastructure.Database).check();

        this.logger.info("Database connection is alive.");

        this.taskQueue = container.get<TaskQueue>(Tokens.TaskQueue.TaskQueue);
        this.runner = container.get<Runner>(Tokens.TaskQueue.Runner);
        this.bot = container.get<Bot>(Tokens.Bot.Bot);

        await this.bot.setup();

        this.isSetup = true;
    }

    public async run(): Promise<void> {
        if (!this.isSetup) {
            throw new RuntimeError("Application is not set up!");
        }

        try {
            this.runner.run();
            await this.bot.run();

            this.isRun = true;

            this.logger.info("Application is successfully started.");
        } catch (error) {
            this.runner.stop();

            throw error;
        }
    }

    public async stop(): Promise<void> {
        if (!this.isSetup) {
            return;
        }

        this.logger.info("Stop application...");

        const { timeout } = this.cc.gracefulShutdown;

        if (!(await withTimeout(this.shutdown(), timeout))) {
            this.logger.warning("Graceful shutdown timeout is over, the shutdown was cut short.", {
                timeout: timeout,
            });

            return;
        }

        this.logger.info("Application is successfully stopped.");
    }

    // Свой срок есть у каждого шага, а общий — у остановки целиком: он больше их суммы
    // (проверяется при сборке конфига), поэтому на остановку брокера и закрытие пула время
    // остаётся даже тогда, когда бот и очередь выбрали своё до конца.
    private async shutdown(): Promise<void> {
        if (this.isRun) {
            await this.bot.stop();
            await this.waitQueueToEmpty();
            this.runner.stop();

            this.isRun = false;
        }

        await container.close();
    }

    private async waitQueueToEmpty(): Promise<void> {
        const { timeout, interval } = this.cc.taskQueue.gracefulShutdown;
        const deadline = Date.now() + timeout;

        while (!this.taskQueue.isEmpty()) {
            const timeLeft = deadline - Date.now();

            if (timeLeft <= 0) {
                this.logger.warning("Shutdown timeout is over, remaining tasks will not be done.", {
                    tasksLeft: this.taskQueue.getTaskCount(),
                    timeout: timeout,
                });

                return;
            }

            this.logger.info(`Waiting for the outgoing queue to empty: ${this.taskQueue.getTaskCount()} tasks left.`);

            await sleep(Math.min(interval, timeLeft));
        }
    }
}
