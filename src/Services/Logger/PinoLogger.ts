import { AbstractLogger } from "App/Services/Logger/AbstractLogger";
import { AnyObject } from "App/Common/Types";
import { Logger, LoggerOptions, pino } from "pino";
import { Level } from "App/Services/Logger/Types";
import { injectable } from "inversify";

const pinoLevels: Record<string, number> = {
    [Level.DEBUG.toLowerCase()]: 0,
    [Level.INFO.toLowerCase()]: 100,
    [Level.WARNING.toLowerCase()]: 200,
    [Level.ERROR.toLowerCase()]: 300,
    [Level.CRITICAL.toLowerCase()]: 400,
};

@injectable()
export class PinoLogger extends AbstractLogger {
    private readonly pinoDefaultOptions: LoggerOptions = {
        customLevels: pinoLevels,
        useOnlyCustomLevels: true,
        level: "debug",
        formatters: {
            level: (label) => {
                return { level: label.toUpperCase() };
            },
        },
    };

    private readonly pino: Logger;

    public constructor(pinoLogger: Logger | null = null) {
        super();

        this.pino = pinoLogger || pino(this.pinoDefaultOptions);
    }

    critical(message: string, payload?: AnyObject): void {
        this.log(Level.CRITICAL, message, payload);
    }

    error(message: string, payload?: AnyObject): void {
        this.log(Level.ERROR, message, payload);
    }

    warning(message: string, payload?: AnyObject): void {
        this.log(Level.WARNING, message, payload);
    }

    info(message: string, payload?: AnyObject): void {
        this.log(Level.INFO, message, payload);
    }

    debug(message: string, payload?: AnyObject): void {
        this.log(Level.DEBUG, message, payload);
    }

    private log(level: Level, message: string, payload?: AnyObject): void {
        if (this.levels.includes(level)) {
            this.pino[level.toLowerCase()]({
                message: message,
                payload: payload,
            });
        }
    }

    child(context: AnyObject): PinoLogger {
        const pinoChild = this.pino.child(context);

        return new PinoLogger(pinoChild);
    }
}
