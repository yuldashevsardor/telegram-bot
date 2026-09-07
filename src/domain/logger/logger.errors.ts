import { RuntimeError } from "app/common/errors";
import { UnknownObject } from "app/common/types";

export class InvalidLogLevel extends RuntimeError {
    static byLevel(level: unknown, payload?: UnknownObject): InvalidLogLevel {
        return new InvalidLogLevel(`Invalid log level. Got: ${level}`, payload);
    }
}
