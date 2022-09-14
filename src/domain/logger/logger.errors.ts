import { RuntimeError } from "app/common/errors";
import { AnyObject } from "app/common/types";

export class InvalidLogLevel extends RuntimeError {
    static byLevel(level: unknown, payload?: AnyObject): InvalidLogLevel {
        return new InvalidLogLevel({
            message: `Invalid log level. Got: ${level}`,
            payload: payload,
        });
    }
}
