import { RuntimeError } from "App/Common/Errors";
import { AnyObject } from "App/Common/Types";

export class InvalidLogLevel extends RuntimeError {
    static byLevel(level: unknown, payload?: AnyObject): InvalidLogLevel {
        return new InvalidLogLevel(`Invalid log level. Got: ${level}`, undefined, payload);
    }
}
