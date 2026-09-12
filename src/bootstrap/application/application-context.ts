import { ConfigContainer } from "app/bootstrap/config-container";
import { ConfigEnvStorage } from "app/platform/config/config-env-storage";
import { Logger } from "app/shared/logger";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { RequestContext } from "app/platform/request-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/application-context.errors";

// Состав того, что приложению нужно всегда: эти объекты существуют до контейнера, потому что
// собрать его без них нельзя. Список намеренно короткий и держится таким: контекст знают
// только Application и Container.setup(), а потребители получают его части из контейнера —
// иначе инжектить начнут сам контекст, и он станет вторым DI.
//
// Класс статический целиком: части лежат на нём, а не в экземпляре, который вызвавший create()
// обязан не потерять. Потерянную ссылку на объект восстановить было бы нечем — собранный
// логгер и хранилище остались бы в процессе без единого входа к ним.
export class ApplicationContext {
    private static config: ConfigContainer | null = null;
    private static logger: Logger | null = null;
    private static requestContext: RequestContext | null = null;

    // Контекст один на процесс: второй сломал бы корреляцию молча — у него своё хранилище
    // запроса, и логгер читал бы не тот стор, который открыл middleware. Поэтому повторный
    // create() не ошибка, а выход без пересборки: части уже собраны и доступны геттерами.
    //
    // Конфиг раньше логгера: из него берётся и адаптер, и порог. Поэтому ошибка конфигурации
    // случается до появления логгера, и печатает её fail() своим фолбэком через console.error.
    public static create(): void {
        if (ApplicationContext.config !== null) {
            return;
        }

        const config = new ConfigContainer(new ConfigEnvStorage());
        const requestContext = new RequestContext();
        const logger = ApplicationContext.createLogger(config, requestContext);

        // Поля заполняются после сборки всех частей: упавший конфиг оставляет контекст пустым,
        // и следующий create() начинает с нуля, а не достраивает половину.
        ApplicationContext.config = config;
        ApplicationContext.requestContext = requestContext;
        ApplicationContext.logger = logger;
    }

    public static getConfigContainer(): ConfigContainer {
        if (ApplicationContext.config === null) {
            throw new ApplicationContextIsNotCreated("ApplicationContext is not created, call create() first.");
        }

        return ApplicationContext.config;
    }

    public static getLogger(): Logger {
        if (ApplicationContext.logger === null) {
            throw new ApplicationContextIsNotCreated("ApplicationContext is not created, call create() first.");
        }

        return ApplicationContext.logger;
    }

    public static getRequestContext(): RequestContext {
        if (ApplicationContext.requestContext === null) {
            throw new ApplicationContextIsNotCreated("ApplicationContext is not created, call create() first.");
        }

        return ApplicationContext.requestContext;
    }

    // Логгер один на процесс: значения запроса он берёт из RequestContext в момент записи,
    // поэтому подменять сам объект под запрос не требуется.
    private static createLogger(config: ConfigContainer, requestContext: RequestContext): Logger {
        const logger = config.isProduction ? new PinoLogger(requestContext) : new ConsoleLogger(requestContext);
        logger.setLevel(config.logger.level);

        return logger;
    }
}
