import { AsyncLocalStorage } from "async_hooks";
import { PinoLogger } from "app/infrastructure/logger/pino.logger";

export const asyncLocalStorage = new AsyncLocalStorage<Map<string, PinoLogger>>();
