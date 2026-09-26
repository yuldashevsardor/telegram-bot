import { container } from "app/bootstrap/container/container";
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import type { CC } from "app/bootstrap/config/container/config-container.types";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import type { Database } from "app/platform/database/database";
import type { Runner } from "app/telegram/outbound-queue/runner/runner";
import type { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import type { Bot } from "app/telegram/bot/bot";
import { sleep, withTimeout } from "app/shared/utils";
import { RuntimeError } from "app/shared/errors";

// One field for the whole lifecycle, not a flag per step raised at its end. Such a flag cannot tell
// a step in progress from one never taken, so a stop() from a second signal during the stop would
// run it again, in parallel with the first. A step in progress keeps its own promise here, for a
// repeated call of the same step and for a stop() in the middle of setup() to await.
type State =
    | { name: "created" }
    // Kept after a failure too, and a repeated setup() gets the same failure: fail() in app.ts ends
    // the process, and nobody redoes the setup. contextReady is the first part of the setup, the
    // assembly of ApplicationContext; stop() awaits it alone for the logger and the deadline.
    | { name: "settingUp"; contextReady: Promise<void>; done: Promise<void> }
    | { name: "ready" }
    | { name: "running" }
    // Kept after a failure too, and a repeated stop() gets the same failure: fail() in app.ts ends
    // the process.
    | { name: "stopping"; done: Promise<void> }
    // Final: the instance is single-use (docs/architecture/application.md, "Application").
    | { name: "stopped" };

export class Application {
    // Filled in createContext() and read by nobody until it is over: assemble() and stop() await it.
    private cc!: CC;
    private logger!: Logger;
    // Filled in assemble() and read by nobody until it is over: run() goes only from ready, and
    // shutdown() touches them only from running.
    private taskQueue!: TaskQueue;
    private runner!: Runner;
    private bot!: Bot;

    private state: State = { name: "created" };

    public async setup(): Promise<void> {
        if (this.state.name === "settingUp") {
            return this.state.done;
        }

        if (this.state.name !== "created") {
            return;
        }

        const contextReady = this.createContext();

        this.state = { name: "settingUp", contextReady: contextReady, done: this.assemble(contextReady) };

        await this.state.done;
    }

    public async run(): Promise<void> {
        // A stop() in the middle of setup() has awaited it and is already closing the application.
        // bootstrap() in app.ts comes here right after, and a throw would take it into fail() with
        // code 1.
        if (this.state.name === "stopping" || this.state.name === "stopped") {
            return;
        }

        if (this.state.name === "running") {
            throw new RuntimeError("Application is already running!");
        }

        if (this.state.name !== "ready") {
            throw new RuntimeError("Application is not set up!");
        }

        // Running from the beginning of the start: a stop() that catches the bot starting goes
        // through the full shutdown, not only the closing of the container. Whether Bot.stop() stops
        // a bot that has not raised its isRun yet is up to Bot. Today it skips such a bot, and there
        // is no window only because Bot.run() has no await.
        this.state = { name: "running" };

        try {
            this.runner.run();
            await this.bot.run();

            this.logger.info("Application is successfully started.");
        } catch (error) {
            this.runner.stop();

            // A stop() during the start has already moved the application into the shutdown, and
            // that cannot be cancelled.
            if (this.state.name === "running") {
                this.state = { name: "ready" };
            }

            throw error;
        }
    }

    public async stop(): Promise<void> {
        if (this.state.name === "created" || this.state.name === "stopped") {
            return;
        }

        // The stop takes the logger and the deadline from the context, so in the middle of its
        // assembly it waits for that first. The overall deadline does not cover that wait: until the
        // config is assembled there is no deadline.
        if (this.state.name === "settingUp") {
            await this.state.contextReady;
        }

        // A signal of the other kind during the stop calls stop() from app.ts again. The call waits
        // for the stop under way: were it to return at once, its process.exit(0) would cut it short.
        if (this.state.name !== "stopping") {
            this.state = { name: "stopping", done: this.terminate(this.state) };
        }

        await this.state.done;
    }

    private async createContext(): Promise<void> {
        await ApplicationContext.create();

        this.cc = ApplicationContext.getConfigContainer();
        this.logger = ApplicationContext.getLogger();
    }

    private async assemble(contextReady: Promise<void>): Promise<void> {
        await contextReady;

        this.logger.info("Setup container...");

        await container.setup();

        this.logger.info("Container successfully setup.");
        this.logger.info("Check database connection...");

        await container.get<Database>(Tokens.Platform.Database).check();

        this.logger.info("Database connection is alive.");

        this.taskQueue = container.get<TaskQueue>(Tokens.Bot.OutboundQueue.TaskQueue);
        this.runner = container.get<Runner>(Tokens.Bot.OutboundQueue.Runner);
        this.bot = container.get<Bot>(Tokens.Bot.Bot);

        await this.bot.setup();

        // A stop() in the middle of the setup has already moved the application into the shutdown,
        // and that cannot be cancelled.
        if (this.state.name === "settingUp") {
            this.state = { name: "ready" };
        }
    }

    private async terminate(from: State): Promise<void> {
        this.logger.info("Stop application...");

        // Before the overall deadline and outside it: once the deadline is over terminate() returns,
        // and a poll left behind would rebuild the configuration of a closed application and hold
        // the event loop.
        this.cc.unwatch();

        const timeout = this.cc.get("gracefulShutdown.timeout");

        const finished = await withTimeout(this.shutdown(from), timeout);

        this.state = { name: "stopped" };

        if (!finished) {
            this.logger.warning("Graceful shutdown timeout is over, the shutdown was cut short.", {
                timeout: timeout,
            });

            return;
        }

        this.logger.info("Application is successfully stopped.");
    }

    // Every step has a deadline of its own, and the whole stop has the overall one. The overall one
    // is greater than their sum (checked when the config is assembled), so stopping the runner and
    // closing the pool have time left even when the bot and the queue use theirs up.
    private async shutdown(from: State): Promise<void> {
        // A failure of the setup leaves from here as well (docs/architecture/application.md, "Stop",
        // step 3). Swallowed, it would leave the exit code to a race between exit(0) and exit(1).
        if (from.name === "settingUp") {
            await from.done;
        }

        if (from.name === "running") {
            await this.bot.stop();
            await this.waitQueueToEmpty();
            this.runner.stop();
        }

        await container.close();
    }

    private async waitQueueToEmpty(): Promise<void> {
        const { timeout, interval } = this.cc.get("taskQueue.gracefulShutdown");
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
