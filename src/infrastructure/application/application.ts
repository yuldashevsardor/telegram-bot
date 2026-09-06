import { container, Loggers } from "app/infrastructure/container/container";
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
import { sleep } from "app/helper/utils";

const PLANNER_POLL_INTERVAL = 3000;

export class Application {
    private config!: ConfigContainer;
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

        this.config = new ConfigContainer(new ConfigEnvStorage());

        const loggers = Application.createLoggers(this.config);
        this.logger = loggers.default;

        this.logger.debug("Setup container...");

        await container.setup(this.config, loggers);

        this.logger.debug("Container successfully setup.");
        this.logger.debug("Check database connection...");

        await container.get<Database>(Infrastructure.Database).check();

        this.logger.debug("Database connection is alive.");

        this.planner = container.get<Planner>(Modules.Planner.Planner);
        this.broker = container.get<Broker>(Modules.Broker.Broker);
        this.bot = container.get<Bot>(Modules.Bot.Bot);

        await this.bot.setup();

        this.isSetup = true;
    }

    public async run(): Promise<void> {
        if (!this.isSetup) {
            throw new Error("Application is not set up!");
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

        if (this.isRun) {
            await this.bot.stop();
            await this.waitPlannerToEmpty();
            await this.broker.stop();

            this.isRun = false;
        }

        await container.close();

        this.logger.info("Application is successfully stopped.");
    }

    // Дочерний логгер запроса подменяет синглтон прозрачно для потребителя: тот работает
    // с одним объектом, а пишет через логгер своего запроса, если он есть в AsyncLocalStorage.
    private static createLoggers(config: ConfigContainer): Loggers {
        const consoleLogger = new ConsoleLogger();
        const pinoLogger = new PinoLogger();

        consoleLogger.setLevel(config.logger.level);
        pinoLogger.setLevel(config.logger.level);

        const scopedPinoLogger = new Proxy(pinoLogger, {
            get(target, property, receiver): unknown {
                const scopedLogger = asyncLocalStorage.getStore()?.get("logger");

                target = scopedLogger instanceof PinoLogger ? scopedLogger : target;

                return Reflect.get(target, property, receiver);
            },
        });

        return {
            console: consoleLogger,
            pino: scopedPinoLogger,
            default: config.logger.default === "PinoLogger" ? scopedPinoLogger : consoleLogger,
        };
    }

    private async waitPlannerToEmpty(): Promise<void> {
        const deadline = Date.now() + this.config.bot.shutdownTimeout;

        while (!this.planner.isEmpty()) {
            const timeLeft = deadline - Date.now();

            if (timeLeft <= 0) {
                this.logger.warning("Shutdown timeout is over, remaining messages will not be sent.", {
                    messagesLeft: this.planner.getMessagesCount(),
                    shutdownTimeout: this.config.bot.shutdownTimeout,
                });
                return;
            }

            this.logger.info(`Waiting for the outgoing queue to empty: ${this.planner.getMessagesCount()} messages left.`);

            await sleep(Math.min(PLANNER_POLL_INTERVAL, timeLeft));
        }
    }
}
