import path from "path";
import { ConfigContainer } from "app/bootstrap/config/config-container";
import type { CC } from "app/bootstrap/config/config-container.types";
import type { ConfigValues } from "app/bootstrap/config/config-values";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigParser } from "app/bootstrap/config/parser/config-parser";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import { ConfigFileStorage } from "app/bootstrap/config/storage/config-file-storage";
import type { Logger } from "app/platform/logger/logger";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { RequestContext } from "app/platform/request-context/request-context";
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
        const cc = new ConfigContainer<ConfigValues>(ApplicationContext.createStorage(), new ConfigValuesBuilder());
        await cc.init();

        const requestContext = new RequestContext();
        const logger = ApplicationContext.createLogger(cc, requestContext);

        // Поля заполняются после сборки всех частей: упавший конфиг оставляет контекст пустым,
        // а не достраивает половину.
        ApplicationContext.cc = cc;
        ApplicationContext.requestContext = requestContext;
        ApplicationContext.logger = logger;

        // Наблюдение включается последним: до подписки логгера отказ пересборки было бы некуда
        // написать, а гасит его остановка приложения (`Application.terminate()`) — оставленный
        // опрос файла пересобирал бы конфигурацию уже закрывающегося приложения.
        cc.onError((error: unknown): void => {
            logger.error("Config reload failed, the previous values are kept.", { cause: error });
        });
        cc.watch();
    }

    // Путь файла и интервал его опроса нужны, чтобы собрать конфигурацию, поэтому берутся из
    // окружения напрямую — в собранных значениях их к этому моменту ещё нет. Разбор тот же, что и
    // у остальных переменных, поэтому недопустимый интервал валит старт, а не выключает
    // наблюдение молча.
    private static createStorage(): ConfigStorage {
        const parser = new ConfigParser({ ...process.env });
        const filePath = parser.getString("CONFIG_FILE_PATH", path.join(process.cwd(), "config", "runtime.env"));
        // Ноль выключает наблюдение: приложению, которому менять значения на ходу не нужно, опрос
        // файла не нужен тоже.
        const watchInterval = parser.getTimerDelay("CONFIG_FILE_WATCH_INTERVAL", 2000, { min: 0 });

        return new ConfigFileStorage(new ConfigEnvStorage(), filePath, watchInterval);
    }

    // Логгер один на процесс: значения запроса он берёт из RequestContext в момент записи,
    // поэтому подменять сам объект под запрос не требуется.
    private static createLogger(cc: CC, requestContext: RequestContext): Logger {
        const logger = cc.get("isProduction") ? new PinoLogger(requestContext) : new ConsoleLogger(requestContext);
        logger.setLevel(cc.get("logger.level"));

        return logger;
    }
}
