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

    critical(message: string, payload?: AnyObject): void {
        this.innerLog(Level.CRITICAL, message, payload);
    }

    error(message: string, payload?: AnyObject): void {
        this.innerLog(Level.ERROR, message, payload);
    }

    warning(message: string, payload?: AnyObject): void {
        this.innerLog(Level.WARNING, message, payload);
    }

    info(message: string, payload?: AnyObject): void {
        this.innerLog(Level.INFO, message, payload);
    }

    notice(message: string, payload?: AnyObject): void {
        this.innerLog(Level.NOTICE, message, payload);
    }

    debug(message: string, payload?: AnyObject): void {
        return this.innerLog(Level.DEBUG, message, payload);
    }

    private innerLog(level: Level, message: string, payload?: AnyObject): void {
        if (this.levels.includes(level)) {
            this.log(level, message, payload);
        }
    }

    protected abstract log(level: Level, message: string, payload?: AnyObject): void;
}
