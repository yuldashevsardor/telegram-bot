import { AbstractLogger } from "app/infrastructure/logger/abstract.logger";
import { AnyObject } from "app/common/types";
import { Logger, LoggerOptions, pino } from "pino";
import { Level } from "app/domain/logger/logger.types";
import { injectable } from "inversify";
import { serializeError } from "serialize-error";

type PinoLevel = Lowercase<Level>;

const pinoLevels: Record<PinoLevel, number> = {
    debug: 0,
    info: 100,
    warning: 200,
    error: 300,
    critical: 400,
};

const pinoLevelByLevel: Record<Level, PinoLevel> = {
    [Level.DEBUG]: "debug",
    [Level.INFO]: "info",
    [Level.WARNING]: "warning",
    [Level.ERROR]: "error",
    [Level.CRITICAL]: "critical",
};

@injectable()
export class PinoLogger extends AbstractLogger {
    private readonly pinoDefaultOptions: LoggerOptions<PinoLevel> = {
        customLevels: pinoLevels,
        useOnlyCustomLevels: true,
        level: "debug",
        formatters: {
            level: (label) => {
                return { level: label.toUpperCase() };
            },
        },
    };

    private pino: Logger<PinoLevel>;

    public constructor() {
        super();

        this.pino = pino<PinoLevel>(this.pinoDefaultOptions);
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
            this.pino[pinoLevelByLevel[level]]({
                message: message,
                payload: serializeError(payload),
            });
        }
    }

    // Дочерний pino подставляется после конструирования, а не аргументом конструктора:
    // inversify резолвит каждый параметр конструктора @injectable-класса, а pino.Logger —
    // интерфейс, для которого design:paramtypes даёт Object, и контейнер падает
    // на "No matching bindings found for serviceIdentifier: Object".
    child(context: AnyObject): PinoLogger {
        const child = new PinoLogger();
        child.pino = this.pino.child(context);

        return child;
    }
}
