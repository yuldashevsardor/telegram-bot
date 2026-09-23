import { AbstractLogger } from "app/platform/logger/abstract-logger";
import type { UnknownObject } from "app/shared/types";
import { Level } from "app/platform/logger/logger.types";
import { injectable } from "inversify";
import dayjs from "dayjs";
import { serializeError } from "serialize-error";

type ConsoleMethod = "error" | "warn" | "info" | "debug";

@injectable()
export class ConsoleLogger extends AbstractLogger {
    public critical(message: string, payload?: UnknownObject): void {
        this.write(Level.CRITICAL, "error", message, payload);
    }

    public error(message: string, payload?: UnknownObject): void {
        this.write(Level.ERROR, "error", message, payload);
    }

    public warning(message: string, payload?: UnknownObject): void {
        this.write(Level.WARNING, "warn", message, payload);
    }

    public info(message: string, payload?: UnknownObject): void {
        this.write(Level.INFO, "info", message, payload);
    }

    public debug(message: string, payload?: UnknownObject): void {
        this.write(Level.DEBUG, "debug", message, payload);
    }

    // The threshold is checked in one place, not in every method: there is no level above
    // CRITICAL, and a check of its own in critical() would be an unreachable branch.
    private write(level: Level, method: ConsoleMethod, message: string, payload?: UnknownObject): void {
        if (!this.isEnabled(level)) {
            return;
        }

        console[method](this.collectFinalMessage(level, message, payload));
    }

    private collectFinalMessage(level: Level, message: string, payload?: UnknownObject): string {
        const messages = [`[${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}]`, `[${level}]`];

        for (const [key, value] of Object.entries(this.requestContext.getValues())) {
            messages.push(`[${key}=${String(value)}]`);
        }

        messages.push(message);

        if (payload) {
            // Without serializeError nested errors would print as {}: name, message and stack
            // of an Error are non-enumerable, and JSON.stringify does not see them.
            messages.push(JSON.stringify(serializeError(payload), null, 4));
        }

        return messages.join(" ");
    }
}
