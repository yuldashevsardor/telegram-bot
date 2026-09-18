import { ConfigContainer } from "app/bootstrap/config/config-container";
import type { CC } from "app/bootstrap/config/config-container.types";
import type { ConfigValues } from "app/bootstrap/config/config-values";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import type { Logger } from "app/platform/logger/logger";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { RequestContext } from "app/platform/request-context/request-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/application-context/application-context.errors";

// Состав того, что приложению нужно всегда: эти объекты существуют до контейнера, потому что
// собрать его без них нельзя. Список намеренно короткий и держится таким: контекст знают
// только Application и Container.setup(), а потребители получают его части из контейнера —
// иначе инжектить начнут сам контекст, и он станет вторым DI.
//
// Класс статический целиком: части лежат на нём, а не в экземпляре, который вызвавший create()
// обязан не потерять. Потерянную ссылку на объект восстановить было бы нечем — собранный
// логгер и хранилище остались бы в процессе без единого входа к ним.
export class ApplicationContext {
    private static cc: CC | null = null;
    private static logger: Logger | null = null;
    private static requestContext: RequestContext | null = null;
    private static creating: Promise<void> | null = null;

    // Контекст один на процесс: второй сломал бы корреляцию молча — у него своё хранилище
    // запроса, и логгер читал бы не тот стор, который открыл middleware. Поэтому повторный
    // create() не ошибка, а та же сборка: вызов посреди неё ждёт её, а не начинает вторую, —
    // конфиг собирается асинхронно, и одна проверка готовых полей пропустила бы оба вызова.
    //
    // Промис живёт, только пока сборка идёт, и забывается при любом исходе: упавшая сборка не
    // мешает следующему create() начать с нуля, а собран ли контекст, create() решает по тем же
    // полям, что и геттеры. Держись промис и после сборки, признаков готовности стало бы два, и
    // контекст с обнулёнными полями (так его сбрасывают спеки) create() не пересобрал бы, а
    // геттеры отвергли бы.
    public static create(): Promise<void> {
        if (ApplicationContext.cc !== null && ApplicationContext.logger !== null && ApplicationContext.requestContext !== null) {
            return Promise.resolve();
        }

        if (ApplicationContext.creating === null) {
            ApplicationContext.creating = ApplicationContext.assemble().finally(() => {
                ApplicationContext.creating = null;
            });
        }

        return ApplicationContext.creating;
    }

    public static getConfigContainer(): CC {
        if (ApplicationContext.cc === null) {
            throw new ApplicationContextIsNotCreated("ApplicationContext is not created, call create() first.");
        }

        return ApplicationContext.cc;
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

    // Конфиг раньше логгера: из него берётся и адаптер, и порог. Поэтому ошибка конфигурации
    // случается до появления логгера, и печатает её fail() своим фолбэком через console.error.
    private static async assemble(): Promise<void> {
        const cc = new ConfigContainer<ConfigValues>(new ConfigEnvStorage(), new ConfigValuesBuilder());
        await cc.init();

        const requestContext = new RequestContext();
        const logger = ApplicationContext.createLogger(cc, requestContext);

        // Поля заполняются после сборки всех частей: упавший конфиг оставляет контекст пустым,
        // а не достраивает половину.
        ApplicationContext.cc = cc;
        ApplicationContext.requestContext = requestContext;
        ApplicationContext.logger = logger;
    }

    // Логгер один на процесс: значения запроса он берёт из RequestContext в момент записи,
    // поэтому подменять сам объект под запрос не требуется.
    private static createLogger(cc: CC, requestContext: RequestContext): Logger {
        const logger = cc.get("isProduction") ? new PinoLogger(requestContext) : new ConsoleLogger(requestContext);
        logger.setLevel(cc.get("logger.level"));

        return logger;
    }
}
