import { UnknownObject } from "app/shared/types";

export interface Logger {
    critical(message: string, payload?: UnknownObject): void;

    error(message: string, payload?: UnknownObject): void;

    warning(message: string, payload?: UnknownObject): void;

    info(message: string, payload?: UnknownObject): void;

    debug(message: string, payload?: UnknownObject): void;
}
