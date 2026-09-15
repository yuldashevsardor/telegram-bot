import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ConfigContainer } from "app/bootstrap/config/config-container";
import type { CC, RawConfig } from "app/bootstrap/config/config-container.types";
import type { ConfigValues } from "app/bootstrap/config/config-values";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import type { Logger } from "app/platform/logger/logger";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { Level } from "app/platform/logger/logger.types";
import { RequestContext } from "app/platform/request-context/request-context";

type ContextParts = {
    cc: CC | null;
    logger: Logger | null;
    requestContext: RequestContext | null;
};

// Части кладутся в статические поля мимо create(): тот собрал бы конфиг из настоящего окружения,
// а шов для тестов менял бы публичную форму контекста.
const context = ApplicationContext as unknown as ContextParts;

function createQuietLogger(requestContext: RequestContext): Logger {
    const logger = new ConsoleLogger(requestContext);
    logger.setLevel(Level.CRITICAL);

    return logger;
}

// Заполняет контекст целиком, как create(), но конфиг собирает из переданных переменных, а не из
// окружения процесса. BOT_TOKEN конфиг требует, а окружение прогона держать настоящий токен не
// обязано. Логгер по умолчанию пишет только critical: TaskQueue на конструировании заводит
// интервалы с info-логом раз в 10 с, гасить их нечем, а в test-watch они копятся между прогонами
// и писали бы в вывод mocha. Упавший конфиг, как и в create(), оставляет контекст пустым.
export async function fillApplicationContext(values: RawConfig = {}, logger?: Logger): Promise<void> {
    const cc = new ConfigContainer<ConfigValues>(
        { load: async (): Promise<RawConfig> => ({ BOT_TOKEN: "test-token", ...values }) },
        new ConfigValuesBuilder(),
    );
    await cc.init();

    const requestContext = new RequestContext();

    context.cc = cc;
    context.requestContext = requestContext;
    context.logger = logger ?? createQuietLogger(requestContext);
}

// Контекст общий на весь прогон mocha: заполненным он молча отдал бы свой конфиг configValue() в
// чужих спеках. Промис сборки не трогается: между сборками create() и так держит его пустым, а
// идущую сборку сброс промиса не отменил бы — она заполнила бы поля уже после сброса.
export function resetApplicationContext(): void {
    context.cc = null;
    context.logger = null;
    context.requestContext = null;
}
