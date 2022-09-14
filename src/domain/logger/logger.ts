import { AnyObject } from "app/common/types";

export interface Logger {
    critical(message: string, payload?: AnyObject): void;

    error(message: string, payload?: AnyObject): void;

    warning(message: string, payload?: AnyObject): void;

    info(message: string, payload?: AnyObject): void;

    debug(message: string, payload?: AnyObject): void;
}
