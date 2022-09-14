import { injectable } from "inversify";
import { NextFunction } from "grammy";
import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { container } from "app/infrastructure/container/container";
import { Logger } from "app/domain/logger/logger";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { v4 as uuid } from "uuid";
import { PinoLogger } from "app/infrastructure/logger/pino.logger";
import { asyncLocalStorage } from "app/infrastructure/async-local-storage";
import { Context } from "app/infrastructure/bot/bot.types";

@injectable()
export class AsyncLocalStorageMiddleware extends Middleware {
    public async handle(context: Context, next: NextFunction): Promise<void> {
        const logger = container.get<Logger>(Infrastructure.Logger);

        if (!(logger instanceof PinoLogger)) {
            return next();
        }

        const child = logger.child({
            requestId: uuid(),
        });

        const store = new Map();
        store.set("logger", child);

        return asyncLocalStorage.run(store, next);
    }
}
