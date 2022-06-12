import { AbstractLogger } from "App/Services/Logger/AbstractLogger";
import { AnyObject } from "App/Common/Types";
import { Level } from "App/Services/Logger/Types";
import { injectable } from "inversify";
import dayjs from "dayjs";

@injectable()
export class ConsoleLogger extends AbstractLogger {
    protected log(level: Level, message: string, payload?: AnyObject): void {
        const messages = [`[${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}]`, `[${level}]`, message];

        if (payload) {
            messages.push(JSON.stringify(payload, null, 2));
        }

        const finalMessage = messages.join(" ");

        if (level === Level.CRITICAL) {
            console.error(finalMessage);
        } else if (level === Level.ERROR) {
            console.error(finalMessage);
        } else if (level === Level.WARNING) {
            console.warn(finalMessage);
        } else if (level === Level.NOTICE) {
            console.info(finalMessage);
        } else if (level === Level.INFO) {
            console.error(finalMessage);
        } else if (level === Level.DEBUG) {
            console.debug(finalMessage);
        } else {
            console.log(finalMessage);
        }
    }
}
