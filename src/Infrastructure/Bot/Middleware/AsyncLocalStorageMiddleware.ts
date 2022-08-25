import { injectable } from "inversify";
import { Context } from "App/Infrastructure/Bot/Context";
import { NextFunction } from "grammy";
import { Middleware } from "App/Infrastructure/Bot/Middleware/Middleware";
import { container } from "App/Infrastructure/Container/Container";
import { Logger } from "App/Domain/Logger/Logger";
import { Infrastructure } from "App/Infrastructure/Container/Symbols/Infrastructure";
import { v4 as uuid } from "uuid";
import { PinoLogger } from "App/Infrastructure/Logger/PinoLogger";
import { asyncLocalStorage } from "App/Infrastructure/AsyncLocalStorage";

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
