import { AsyncLocalStorage } from "async_hooks";
import { ConfigContainer } from "app/infrastructure/config/config-container";
import { ConfigEnvStorage } from "app/infrastructure/config/config-env-storage";
import { Logger } from "app/domain/logger/logger";
import { ConsoleLogger } from "app/infrastructure/logger/console-logger";
import { PinoLogger } from "app/infrastructure/logger/pino-logger";
import { AlsStore } from "app/infrastructure/async-local-storage.types";
import { ApplicationContextAlreadyCreated } from "app/infrastructure/application/application-context.errors";

// Состав того, что приложению нужно всегда: эти объекты существуют до контейнера, потому что
// собрать его без них нельзя. Список намеренно короткий и держится таким: контекст знают
// только Application и Container.setup(), а потребители получают его части из контейнера —
// иначе инжектить начнут сам контекст, и он станет вторым DI.
export class ApplicationContext {
    private static created = false;

    private constructor(
        public readonly config: ConfigContainer,
        public readonly logger: Logger,
        public readonly asyncLocalStorage: AsyncLocalStorage<AlsStore>,
    ) {}

    // Контекст один на процесс, и это проверяется: второй сломал бы корреляцию молча —
    // у него своё хранилище запроса, и логгер читал бы не тот стор, который открыл
    // middleware. Отсюда же приватный конструктор: другого способа собрать контекст нет.
    //
    // Конфиг раньше логгера: из него берётся и адаптер, и порог. Поэтому ошибка конфигурации
    // случается до появления логгера, и печатает её fail() через console.error.
    public static create(): ApplicationContext {
        if (ApplicationContext.created) {
            throw new ApplicationContextAlreadyCreated("ApplicationContext is already created.");
        }

        const config = new ConfigContainer(new ConfigEnvStorage());
        const asyncLocalStorage = new AsyncLocalStorage<AlsStore>();
        const context = new ApplicationContext(config, ApplicationContext.createLogger(config, asyncLocalStorage), asyncLocalStorage);

        // Флаг после сборки: упавший конфиг оставляет процесс без контекста, и повторная
        // попытка должна падать своей ошибкой, а не этой.
        ApplicationContext.created = true;

        return context;
    }

    // Логгер один на процесс: данные запроса он берёт из AsyncLocalStorage в момент записи,
    // поэтому подменять сам объект под запрос не требуется.
    private static createLogger(config: ConfigContainer, asyncLocalStorage: AsyncLocalStorage<AlsStore>): Logger {
        const logger = config.isProduction ? new PinoLogger(asyncLocalStorage) : new ConsoleLogger(asyncLocalStorage);
        logger.setLevel(config.logger.level);

        return logger;
    }
}
