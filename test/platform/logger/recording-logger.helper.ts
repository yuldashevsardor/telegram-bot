import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";

export type LogRecord = { message: string; payload: UnknownObject | undefined };

// Records every level apart, in call order: a spec reads the level it asserts on.
export class RecordingLogger implements Logger {
    public readonly criticals: LogRecord[] = [];
    public readonly errors: LogRecord[] = [];
    public readonly warnings: LogRecord[] = [];
    public readonly infos: LogRecord[] = [];
    public readonly debugs: LogRecord[] = [];

    public critical(message: string, payload?: UnknownObject): void {
        this.criticals.push({ message: message, payload: payload });
    }

    public error(message: string, payload?: UnknownObject): void {
        this.errors.push({ message: message, payload: payload });
    }

    public warning(message: string, payload?: UnknownObject): void {
        this.warnings.push({ message: message, payload: payload });
    }

    public info(message: string, payload?: UnknownObject): void {
        this.infos.push({ message: message, payload: payload });
    }

    public debug(message: string, payload?: UnknownObject): void {
        this.debugs.push({ message: message, payload: payload });
    }
}
