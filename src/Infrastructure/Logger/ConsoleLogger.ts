import { AbstractLogger } from "App/Infrastructure/Logger/AbstractLogger";
import { AnyObject } from "App/Common/Types";
import { Level } from "App/Domain/Logger/Types";
import { injectable } from "inversify";
import dayjs from "dayjs";

@injectable()
export class ConsoleLogger extends AbstractLogger {
    public critical(message: string, payload?: AnyObject): void {
        const level = Level.CRITICAL;

        if (!this.levels.includes(level)) {
            return;
        }

        console.error(ConsoleLogger.collectFinalMessage(level, message, payload));
    }

    public error(message: string, payload?: AnyObject): void {
        const level = Level.ERROR;

        if (!this.levels.includes(level)) {
            return;
        }

        console.error(ConsoleLogger.collectFinalMessage(level, message, payload));
    }

    public warning(message: string, payload?: AnyObject): void {
        const level = Level.WARNING;

        if (!this.levels.includes(level)) {
            return;
        }

        console.warn(ConsoleLogger.collectFinalMessage(level, message, payload));
    }

    public info(message: string, payload?: AnyObject): void {
        const level = Level.INFO;

        if (!this.levels.includes(level)) {
            return;
        }

        console.info(ConsoleLogger.collectFinalMessage(level, message, payload));
    }

    public debug(message: string, payload?: AnyObject): void {
        const level = Level.DEBUG;

        if (!this.levels.includes(level)) {
            return;
        }

        console.debug(ConsoleLogger.collectFinalMessage(level, message, payload));
    }

    private static collectFinalMessage(level: Level, message: string, payload?: AnyObject): string {
        const messages = [`[${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}]`, `[${level}]`, message];

        if (payload) {
            messages.push(JSON.stringify(payload, null, 4));
        }

        return messages.join(" ");
    }
}
