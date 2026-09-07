import { Logger } from "app/domain/logger/logger";
import { Level, Levels, LevelSeverity } from "app/domain/logger/logger.types";
import { UnknownObject } from "app/common/types";
import { InvalidLogLevel } from "app/domain/logger/logger.errors";
import { injectable } from "inversify";
import { AsyncLocalStorage } from "async_hooks";
import { ALS_KEYS, AlsStore } from "app/infrastructure/async-local-storage.types";

@injectable()
export abstract class AbstractLogger implements Logger {
    protected level: Level = Level.DEBUG;

    // Хранилище приходит зависимостью: логгер всегда знает про него и сам забирает данные
    // запроса в момент записи, поэтому под запрос не подменяется и не пересобирается.
    public constructor(protected readonly asyncLocalStorage: AsyncLocalStorage<AlsStore>) {}

    public setLevel(level: Level): void {
        if (!Levels.includes(level)) {
            throw InvalidLogLevel.byLevel(level);
        }

        this.level = level;
    }

    protected isEnabled(level: Level): boolean {
        return LevelSeverity[level] >= LevelSeverity[this.level];
    }

    // В записи попадают только известные ключи: стор нетипизирован, и без отбора формат
    // лога зависел бы от того, что в него положили по дороге.
    protected getRequestContext(): AlsStore {
        const store = this.asyncLocalStorage.getStore();

        if (!store) {
            return {};
        }

        const context: AlsStore = {};

        for (const key of Object.values(ALS_KEYS)) {
            if (store[key] !== undefined) {
                context[key] = store[key];
            }
        }

        return context;
    }

    public abstract critical(message: string, payload?: UnknownObject): void;

    public abstract error(message: string, payload?: UnknownObject): void;

    public abstract warning(message: string, payload?: UnknownObject): void;

    public abstract info(message: string, payload?: UnknownObject): void;

    public abstract debug(message: string, payload?: UnknownObject): void;
}
