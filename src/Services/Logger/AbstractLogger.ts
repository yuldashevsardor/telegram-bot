import { Logger } from "App/Services/Logger/Logger";
import { Level, Levels } from "App/Services/Logger/Types";
import { AnyObject } from "App/Common/Types";
import { InvalidLogLevel } from "App/Services/Logger/Errors";
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
