import { AbstractLogger } from "app/infrastructure/logger/abstract.logger";
import { UnknownObject } from "app/common/types";
import { Level } from "app/domain/logger/logger.types";
import { injectable } from "inversify";
import dayjs from "dayjs";
import { serializeError } from "serialize-error";

@injectable()
export class ConsoleLogger extends AbstractLogger {
    public critical(message: string, payload?: UnknownObject): void {
        const level = Level.CRITICAL;

        if (!this.isEnabled(level)) {
            return;
        }

        console.error(ConsoleLogger.collectFinalMessage(level, message, payload));
    }

    public error(message: string, payload?: UnknownObject): void {
        const level = Level.ERROR;

        if (!this.isEnabled(level)) {
            return;
        }

        console.error(ConsoleLogger.collectFinalMessage(level, message, payload));
    }

    public warning(message: string, payload?: UnknownObject): void {
        const level = Level.WARNING;

        if (!this.isEnabled(level)) {
            return;
        }

        console.warn(ConsoleLogger.collectFinalMessage(level, message, payload));
    }

    public info(message: string, payload?: UnknownObject): void {
        const level = Level.INFO;

        if (!this.isEnabled(level)) {
            return;
        }

        console.info(ConsoleLogger.collectFinalMessage(level, message, payload));
    }

    public debug(message: string, payload?: UnknownObject): void {
        const level = Level.DEBUG;

        if (!this.isEnabled(level)) {
            return;
        }

        console.debug(ConsoleLogger.collectFinalMessage(level, message, payload));
    }

    private static collectFinalMessage(level: Level, message: string, payload?: UnknownObject): string {
        const messages = [`[${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}]`, `[${level}]`, message];

        if (payload) {
            // Без serializeError вложенные ошибки печатались бы как {}: свойства name,
            // message и stack у Error неперечислимы, и JSON.stringify их не видит.
            messages.push(JSON.stringify(serializeError(payload), null, 4));
        }

        return messages.join(" ");
    }
}
