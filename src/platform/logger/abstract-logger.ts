import type { Logger } from "app/platform/logger/logger";
import { Level, Levels, LevelSeverity } from "app/platform/logger/logger.types";
import type { UnknownObject } from "app/shared/types";
import { InvalidLogLevel } from "app/platform/logger/logger.errors";
import { injectable } from "inversify";
import type { RequestContext } from "app/platform/request-context/request-context";

@injectable()
export abstract class AbstractLogger implements Logger {
    protected level: Level = Level.DEBUG;

    // Контекст приходит зависимостью: логгер всегда знает про него и сам забирает значения
    // запроса в момент записи, поэтому под запрос не подменяется и не пересобирается.
    public constructor(protected readonly requestContext: RequestContext) {}

    public setLevel(level: Level): void {
        if (!Levels.includes(level)) {
            throw InvalidLogLevel.byLevel(level);
        }

        this.level = level;
    }

    protected isEnabled(level: Level): boolean {
        return LevelSeverity[level] >= LevelSeverity[this.level];
    }

    public abstract critical(message: string, payload?: UnknownObject): void;

    public abstract error(message: string, payload?: UnknownObject): void;

    public abstract warning(message: string, payload?: UnknownObject): void;

    public abstract info(message: string, payload?: UnknownObject): void;

    public abstract debug(message: string, payload?: UnknownObject): void;
}
