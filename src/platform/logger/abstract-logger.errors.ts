import { RuntimeError } from "app/shared/errors";
import { UnknownObject } from "app/shared/types";

export class InvalidLogLevel extends RuntimeError {
    static byLevel(level: unknown, payload?: UnknownObject): InvalidLogLevel {
        return new InvalidLogLevel(`Invalid log level. Got: ${level}`, payload);
    }
}
