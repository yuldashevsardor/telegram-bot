import { AbstractLogger } from "app/infrastructure/logger/abstract.logger";
import { AnyObject } from "app/common/types";
import { Logger, LoggerOptions, pino } from "pino";
import { Level } from "app/domain/logger/logger.types";
import { injectable } from "inversify";
import { serializeError } from "serialize-error";

// Уровни объявлены через customLevels, поэтому в типе pino.Logger соответствующих методов нет.
type PinoCustomLevelLogger = Record<Lowercase<Level>, (payload: AnyObject) => void>;

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

    private pino: Logger;

    public constructor() {
        super();

        this.pino = pino(this.pinoDefaultOptions);
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
            const pinoLevel = level.toLowerCase() as Lowercase<Level>;

            (this.pino as unknown as PinoCustomLevelLogger)[pinoLevel]({
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
