import { AbstractLogger } from "app/infrastructure/logger/abstract.logger";
import { UnknownObject } from "app/common/types";
import { Logger, LoggerOptions, pino } from "pino";
import { Level, LevelSeverity } from "app/domain/logger/logger.types";
import { injectable } from "inversify";
import { serializeError } from "serialize-error";

type PinoLevel = Lowercase<Level>;

const pinoLevels: Record<PinoLevel, number> = {
    debug: LevelSeverity[Level.DEBUG],
    info: LevelSeverity[Level.INFO],
    warning: LevelSeverity[Level.WARNING],
    error: LevelSeverity[Level.ERROR],
    critical: LevelSeverity[Level.CRITICAL],
};

const pinoLevelNames: Record<Level, PinoLevel> = {
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
        level: pinoLevelNames[Level.DEBUG],
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

    public override setLevel(level: Level): void {
        super.setLevel(level);

        this.pino.level = pinoLevelNames[level];
    }

    critical(message: string, payload?: UnknownObject): void {
        this.log(Level.CRITICAL, message, payload);
    }

    error(message: string, payload?: UnknownObject): void {
        this.log(Level.ERROR, message, payload);
    }

    warning(message: string, payload?: UnknownObject): void {
        this.log(Level.WARNING, message, payload);
    }

    info(message: string, payload?: UnknownObject): void {
        this.log(Level.INFO, message, payload);
    }

    debug(message: string, payload?: UnknownObject): void {
        this.log(Level.DEBUG, message, payload);
    }

    private log(level: Level, message: string, payload?: UnknownObject): void {
        this.pino[pinoLevelNames[level]]({
            message: message,
            // serialize-error с 13.x заворачивает любое не-Error значение в NonError,
            // поэтому вызов без payload давал бы «Non-error value: undefined» в каждой
            // такой записи.
            payload: payload === undefined ? undefined : serializeError(payload),
        });
    }

    // Дочерний pino подставляется после конструирования, а не аргументом конструктора:
    // inversify резолвит каждый параметр конструктора @injectable-класса, а pino.Logger —
    // интерфейс, для которого design:paramtypes даёт Object, и контейнер падает
    // на "No matching bindings found for serviceIdentifier: Object".
    child(context: UnknownObject): PinoLogger {
        const child = new PinoLogger();
        child.pino = this.pino.child(context);
        child.setLevel(this.level);

        return child;
    }
}
