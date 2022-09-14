import { Logger } from "app/domain/logger/logger";
import { Level, Levels } from "app/domain/logger/logger.types";
import { AnyObject } from "app/common/types";
import { InvalidLogLevel } from "app/domain/logger/logger.errors";
import { injectable } from "inversify";

@injectable()
export abstract class AbstractLogger implements Logger {
    protected levels: Array<Level> = [];

    public setLevels(levels: Array<Level>): void {
        for (const level of levels) {
            if (!Levels.includes(level)) {
                throw InvalidLogLevel.byLevel(level);
            }
        }

        this.levels = levels;
    }

    public abstract critical(message: string, payload?: AnyObject): void;

    public abstract error(message: string, payload?: AnyObject): void;

    public abstract warning(message: string, payload?: AnyObject): void;

    public abstract info(message: string, payload?: AnyObject): void;

    public abstract debug(message: string, payload?: AnyObject): void;
}
