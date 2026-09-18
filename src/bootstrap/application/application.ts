import { container } from "app/bootstrap/container/container";
import { ApplicationContext } from "app/bootstrap/application/application-context/application-context";
import type { CC } from "app/bootstrap/config/config-container.types";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import type { Database } from "app/platform/database/database";
import type { Runner } from "app/telegram/outbound-queue/runner/runner";
import type { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import type { Bot } from "app/telegram/bot";
import { sleep, withTimeout } from "app/shared/utils";
import { RuntimeError } from "app/shared/errors";

// Одно поле на весь жизненный цикл, а не флаг на шаг, поднятый в его конце: по такому флагу
// идущий шаг не отличить от несделанного, и stop() от второго сигнала посреди остановки
// прошёл бы её заново, параллельно первой. Идущий шаг хранит свой промис: его ждут повторный
// вызов того же шага и stop() посреди setup().
type State =
    | { name: "created" }
    // Остаётся и после отказа, повторный setup() отдаёт тот же отказ: процесс после него
    // завершает fail() в app.ts, и повторять настройку некому. contextReady — первая часть настройки,
    // сборка ApplicationContext: её отдельно ждёт stop(), которому нужны логгер и срок из конфига.
    | { name: "settingUp"; contextReady: Promise<void>; done: Promise<void> }
    | { name: "ready" }
    | { name: "running" }
    // Остаётся и после отказа, повторный stop() отдаёт тот же отказ: процесс после него
    // завершает fail() в app.ts.
    | { name: "stopping"; done: Promise<void> }
    // Конечное, экземпляр одноразовый: контейнер-синглтон после close() второй setup() не
    // переживает, а ApplicationContext один на процесс.
    | { name: "stopped" };

export class Application {
    // Заполняются в createContext() и до её конца никем не читаются: assemble() и stop() её ждут.
    private cc!: CC;
    private logger!: Logger;
    // Заполняются в assemble() и до её конца никем не читаются: run() идёт только из ready, а
    // shutdown() трогает их только из running.
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
        // stop() посреди setup() дождался его и уже закрывает приложение, а bootstrap() в
        // app.ts приходит сюда следом: отказ увёл бы его в fail() с кодом 1.
        if (this.state.name === "stopping" || this.state.name === "stopped") {
            return;
        }

        if (this.state.name === "running") {
            throw new RuntimeError("Application is already running!");
        }

        if (this.state.name !== "ready") {
            throw new RuntimeError("Application is not set up!");
        }

        // Запущенным приложение считается с начала запуска: stop(), который застанет бот
        // стартующим, проходит полную остановку, а не закрывает один контейнер. Остановит ли
        // Bot.stop() бот, ещё не поднявший свой isRun, решает Bot: сейчас такой бот он
        // пропускает, а окна нет только потому, что в Bot.run() нет await.
        this.state = { name: "running" };

        try {
            this.runner.run();
            await this.bot.run();

            this.logger.info("Application is successfully started.");
        } catch (error) {
            this.runner.stop();

            // stop() во время запуска уже перевёл приложение в остановку, отменять её нельзя.
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

        // Остановка берёт логгер и срок из контекста, поэтому посреди его сборки сперва ждёт её.
        // Общий срок на это ожидание не распространяется: пока конфиг не собран, срока нет.
        if (this.state.name === "settingUp") {
            await this.state.contextReady;
        }

        // Сигнал другого вида во время остановки снова зовёт stop() из app.ts. Вызов ждёт
        // идущую остановку: вернись он сразу, его process.exit(0) оборвал бы её.
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

        // stop() посреди настройки уже перевёл приложение в остановку, отменять её нельзя.
        if (this.state.name === "settingUp") {
            this.state = { name: "ready" };
        }
    }

    private async terminate(from: State): Promise<void> {
        this.logger.info("Stop application...");

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

    // Свой срок есть у каждого шага, а общий — у остановки целиком: он больше их суммы
    // (проверяется при сборке конфига), поэтому на остановку брокера и закрытие пула время
    // остаётся даже тогда, когда бот и очередь выбрали своё до конца.
    private async shutdown(from: State): Promise<void> {
        // Отказ настройки уходит и отсюда: gracefulStop() и bootstrap() в app.ts оба зовут
        // fail() с одной ошибкой, первый вызов завершает процесс синхронно, и critical
        // остаётся один. Проглоти его остановка, код выхода решала бы гонка exit(0) с exit(1).
        // Stryker disable next-line ConditionalExpression: `true` — у других состояний промиса нет, а await undefined только откладывает остановку на микрозадачу
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
