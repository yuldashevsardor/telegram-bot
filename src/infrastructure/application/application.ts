import { container } from "app/infrastructure/container/container";
import { ConfigContainer } from "app/infrastructure/config/config-container";
import { ConfigEnvStorage } from "app/infrastructure/config/config-env-storage";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { Logger } from "app/domain/logger/logger";
import { ConsoleLogger } from "app/infrastructure/logger/console.logger";
import { PinoLogger } from "app/infrastructure/logger/pino.logger";
import { asyncLocalStorage } from "app/infrastructure/async-local-storage";
import { Database } from "app/infrastructure/database/database";
import { Broker } from "app/domain/broker/broker";
import { Planner } from "app/domain/planner/planner";
import { Bot } from "app/infrastructure/bot/bot";
import { sleep, withTimeout } from "app/helper/utils";
import { RuntimeError } from "app/common/errors";

export class Application {
    private cc!: ConfigContainer;
    private logger!: Logger;
    private planner!: Planner;
    private broker!: Broker;
    private bot!: Bot;

    private isSetup = false;
    private isRun = false;

    public async setup(): Promise<void> {
        if (this.isSetup) {
            return;
        }

        this.cc = new ConfigContainer(new ConfigEnvStorage());
        this.logger = Application.createLogger(this.cc);

        this.logger.info("Setup container...");

        await container.setup(this.cc, this.logger);

        this.logger.info("Container successfully setup.");
        this.logger.info("Check database connection...");

        await container.get<Database>(Infrastructure.Database).check();

        this.logger.info("Database connection is alive.");

        this.planner = container.get<Planner>(Modules.Planner.Planner);
        this.broker = container.get<Broker>(Modules.Broker.Broker);
        this.bot = container.get<Bot>(Modules.Bot.Bot);

        await this.bot.setup();

        this.isSetup = true;
    }

    public async run(): Promise<void> {
        if (!this.isSetup) {
            throw new RuntimeError({ message: "Application is not set up!" });
        }

        try {
            await this.broker.run();
            await this.bot.run();

            this.isRun = true;

            this.logger.info("Application is successfully started.");
        } catch (error) {
            this.broker.stop();

            this.logger.critical("Unhandled error on application start", { error: error });

            throw error;
        }
    }

    public async stop(): Promise<void> {
        if (!this.isSetup) {
            return;
        }

        this.logger.info("Stop application...");

        const { timeout } = this.cc.gracefulShutdown;
        const deadline = Date.now() + timeout;
        let onTime = true;

        if (this.isRun) {
            onTime = await withTimeout(this.bot.stop(), deadline - Date.now());

            if (onTime) {
                onTime = await this.waitPlannerToEmpty(deadline);
            }

            await this.broker.stop();

            this.isRun = false;
        }

        // Пул Postgres закрываем в любом случае, даже когда срок уже вышел: шаг быстрый, свой
        // предел у sql.end() есть, а брошенное соединение — ровно то, ради чего закрытие и
        // переехало сюда из app.ts.
        await container.close();

        if (!onTime) {
            this.logger.warning("Graceful shutdown timeout is over, the shutdown was cut short.", {
                timeout: timeout,
            });

            return;
        }

        this.logger.info("Application is successfully stopped.");
    }

    private static createLogger(cc: ConfigContainer): Logger {
        if (!cc.isProduction) {
            const consoleLogger = new ConsoleLogger();
            consoleLogger.setLevel(cc.logger.level);

            return consoleLogger;
        }

        const pinoLogger = new PinoLogger();
        pinoLogger.setLevel(cc.logger.level);

        // Дочерний логгер запроса подменяет синглтон прозрачно для потребителя: тот работает
        // с одним объектом, а пишет через логгер своего запроса, если он есть в AsyncLocalStorage.
        // От самой обёртки предстоит избавиться — issue #40.
        return new Proxy(pinoLogger, {
            get(target, property, receiver): unknown {
                const scopedLogger = asyncLocalStorage.getStore()?.get("logger");

                target = scopedLogger instanceof PinoLogger ? scopedLogger : target;

                return Reflect.get(target, property, receiver);
            },
        });
    }

    private async waitPlannerToEmpty(deadline: number): Promise<boolean> {
        const { timeout, plannerInterval } = this.cc.gracefulShutdown;

        while (!this.planner.isEmpty()) {
            const timeLeft = deadline - Date.now();

            if (timeLeft <= 0) {
                this.logger.warning("Shutdown timeout is over, remaining messages will not be sent.", {
                    messagesLeft: this.planner.getMessagesCount(),
                    timeout: timeout,
                });

                return false;
            }

            this.logger.info(`Waiting for the outgoing queue to empty: ${this.planner.getMessagesCount()} messages left.`);

            await sleep(Math.min(plannerInterval, timeLeft));
        }

        return true;
    }
}
