import path from "path";
import { Level, Levels } from "app/platform/logger/logger.types";
import { InvalidConfigError } from "app/shared/errors";
import type { UnknownObject } from "app/shared/types";
import { ConfigReader } from "app/bootstrap/config-reader";
import type { IntegerRange } from "app/bootstrap/config-reader";
import type { Limit } from "app/telegram/outbound-queue/rate-limit.types";
import type { RunnerSettings } from "app/telegram/outbound-queue/runner.types";
import type { DatabaseSettings } from "app/platform/database/database.types";
import type { ConfigStorage } from "app/platform/config/config-storage";
import type { BotSettings } from "app/telegram/bot.types";

type LoggerConfig = {
    level: Level;
};

const Environments = ["production", "development", "testing"] as const;

type Leaf = string | number | boolean | bigint | symbol | null | undefined;

// Все «точечные» пути внутрь T: сам ключ, а для вложенного объекта — ещё и пути под ним.
// У листа набор путей пуст, и `${Key}.${never}` схлопывается в never, поэтому за примитив
// путь не продолжается.
type Paths<T> = T extends Leaf
    ? never
    : {
          [Key in keyof T & string]: Key | `${Key}.${Paths<T[Key]>}`;
      }[keyof T & string];

type ValueByPath<T, Path extends string> = Path extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
        ? ValueByPath<T[Key], Rest>
        : never
    : Path extends keyof T
    ? T[Path]
    : never;

export type Environment = (typeof Environments)[number];

// Лимиты бота по областям: общий на весь исходящий трафик и по одному на приватный чат и на
// группу. Какой из них достанется партиции, решает TelegramLimitResolver, а не сама очередь.
export type TelegramLimits = {
    common: Limit;
    private: Limit;
    group: Limit;
};

// Вся конфигурация по секциям. Форма секций объявлена у потребителей и сюда только собрана.
export type ConfigValues = {
    environment: Environment;
    isProduction: boolean;

    rootDir: string;
    tempDir: string;
    fontForgePath: string;

    limits: TelegramLimits;

    runner: RunnerSettings;

    bot: BotSettings;

    taskQueue: {
        logInterval: number;
        gracefulShutdown: {
            timeout: number;
            interval: number;
        };
    };

    gracefulShutdown: {
        timeout: number;
    };

    logger: LoggerConfig;

    database: DatabaseSettings;
};

export type ConfigPath = Paths<ConfigValues>;

export type ConfigValue<Path extends ConfigPath> = ValueByPath<ConfigValues, Path>;

export class ConfigContainer {
    // Остывание слота RateLimit — interval / number: ноль в number делает его бесконечным, и слот
    // не освобождается никогда, а ноль в interval — нулевым, и лимит перестаёт ограничивать.
    private static readonly LIMIT_RANGE: IntegerRange = { min: 1 };

    // Сроки пула в секундах: postgres.js умножает их на 1000 для setTimeout, поэтому потолок —
    // наибольшая задержка таймера в секундах. Ноль у него выключает таймер, а отрицательное
    // значение истинно и закрыло бы соединение через 1 мс.
    private static readonly DATABASE_TIMER_RANGE: IntegerRange = {
        min: 0,
        max: Math.floor(ConfigReader.MAX_TIMER_DELAY / 1000),
    };

    private readonly values: ConfigValues;

    private readonly reader: ConfigReader;

    public constructor(storage: ConfigStorage) {
        this.reader = new ConfigReader(storage);

        const environment = this.reader.getEnum("NODE_ENV", Environments, "development");
        const isProduction = environment === "production";
        const rootDir = process.cwd();

        this.values = {
            environment: environment,
            isProduction: isProduction,

            rootDir: rootDir,
            tempDir: this.reader.getString("TEMP_DIR", path.join(rootDir, "tmp")),
            fontForgePath: this.reader.getString("FONT_FORGE_PATH", "fontforge"),

            limits: {
                common: {
                    number: this.reader.getInteger("LIMIT_COMMON_NUMBER", 30, ConfigContainer.LIMIT_RANGE),
                    interval: this.reader.getInteger("LIMIT_COMMON_INTERVAL", 1000, ConfigContainer.LIMIT_RANGE), // 1 секунда
                },
                private: {
                    number: this.reader.getInteger("LIMIT_PRIVATE_NUMBER", 3, ConfigContainer.LIMIT_RANGE),
                    interval: this.reader.getInteger("LIMIT_PRIVATE_INTERVAL", 1000, ConfigContainer.LIMIT_RANGE), // 1 секунда
                },
                group: {
                    number: this.reader.getInteger("LIMIT_GROUP_NUMBER", 20, ConfigContainer.LIMIT_RANGE),
                    interval: this.reader.getInteger("LIMIT_GROUP_INTERVAL", 60 * 1000, ConfigContainer.LIMIT_RANGE), // 1 минута
                },
            },

            runner: this.getRunner(),

            bot: {
                token: this.reader.getString("BOT_TOKEN"),
                gracefulShutdown: {
                    timeout: this.reader.getTimerDelay("BOT_GRACEFUL_SHUTDOWN_TIMEOUT", 3000, { min: 0 }),
                },
            },

            taskQueue: {
                logInterval: this.reader.getTimerDelay("TASK_QUEUE_LOG_INTERVAL", 10 * 1000), // 10 секунд
                gracefulShutdown: {
                    timeout: this.reader.getTimerDelay("TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT", 5000, { min: 0 }),
                    interval: this.reader.getTimerDelay("TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL", 500),
                },
            },

            gracefulShutdown: {
                timeout: this.reader.getTimerDelay("GRACEFUL_SHUTDOWN_TIMEOUT", 15000),
            },

            logger: this.getLogger(isProduction),
            database: this.getDatabase(),
        };

        this.checkGracefulShutdown();
    }

    // Значение по «точечному» пути: get("bot.token"). Путь и тип результата компилятор выводит
    // из ConfigValues.
    public get<Path extends ConfigPath>(path: Path): ConfigValue<Path> {
        const value = path.split(".").reduce<unknown>((current, key) => {
            if (current === null || typeof current !== "object") {
                return undefined;
            }

            return (current as UnknownObject)[key];
        }, this.values);

        // Путь проверен компилятором, поэтому сюда приводит не опечатка в нём, а расхождение
        // объявленной формы конфигурации с настоящей — необязательное поле, ставшее undefined.
        if (value === undefined) {
            throw new InvalidConfigError(`Invalid config "${path}"`, {
                path: path,
            });
        }

        // Приведение результата: обход по точкам компилятору не проследить, но путь он уже сверил
        // с ConfigValues, и ValueByPath выводит тип из того же места, откуда пришло значение.
        return value as ConfigValue<Path>;
    }

    // Из этих границ Runner случайно выбирает паузу на каждой пустой итерации, поэтому пустой
    // диапазон ломает выбор молча.
    private getRunner(): RunnerSettings {
        const min = this.reader.getTimerDelay("RUNNER_SLEEP_INTERVAL_MIN", 10);
        const max = this.reader.getTimerDelay("RUNNER_SLEEP_INTERVAL_MAX", 1000);
        const maxRetries = this.reader.getInteger("RUNNER_MAX_RETRIES", 3, { min: 0 });

        if (max < min) {
            throw new InvalidConfigError("RUNNER_SLEEP_INTERVAL_MAX must not be less than RUNNER_SLEEP_INTERVAL_MIN", {
                min: min,
                max: max,
            });
        }

        return {
            sleepInterval: { min: min, max: max },
            maxRetries: maxRetries,
        };
    }

    // Сроки бота и очереди расходуются последовательно внутри общего, поэтому общий должен
    // покрывать их сумму. Дальше этого проверка не идёт: приложение не пересчитывает
    // собственные сроки всех своих зависимостей (у sql.end() внутри Database.close(), скажем,
    // свои 5 секунд) — общий срок просто берётся с запасом, а не выводится из них.
    private checkGracefulShutdown(): void {
        const { bot, taskQueue, gracefulShutdown } = this.values;
        const parts = bot.gracefulShutdown.timeout + taskQueue.gracefulShutdown.timeout;

        if (gracefulShutdown.timeout <= parts) {
            throw new InvalidConfigError("GRACEFUL_SHUTDOWN_TIMEOUT must be greater than the sum of the bot and task queue timeouts", {
                application: gracefulShutdown.timeout,
                bot: bot.gracefulShutdown.timeout,
                taskQueue: taskQueue.gracefulShutdown.timeout,
            });
        }
    }

    private getLogger(isProduction: boolean): LoggerConfig {
        const defaultLevel = isProduction ? Level.WARNING : Level.DEBUG;

        return {
            level: this.reader.getEnum("LOGGER_LEVEL", Levels, defaultLevel, { ignoreCase: true }),
        };
    }

    private getDatabase(): DatabaseSettings {
        return {
            host: this.reader.getString("DATABASE_HOST", "localhost"),
            port: this.reader.getPort("DATABASE_PORT", 5432),
            database: this.reader.getString("DATABASE_NAME", "postgres"),
            username: this.reader.getString("DATABASE_USER_NAME", "docker"),
            password: this.reader.getString("DATABASE_USER_PASSWORD", ""),
            connection: {
                max: this.reader.getInteger("DATABASE_CONNECTION_LIMIT", 10, { min: 1 }),
                idleTimeout: this.reader.getInteger("DATABASE_CONNECTION_IDLE_TIMEOUT", 10, ConfigContainer.DATABASE_TIMER_RANGE),
                maxLifetime: this.reader.getInteger("DATABASE_CONNECTION_MAX_LIFETIME", 60 * 10, ConfigContainer.DATABASE_TIMER_RANGE),
            },
        };
    }
}
