import { injectable } from "inversify";
import { Context } from "App/Modules/Bot/Context";
import { NextFunction } from "grammy";
import { Middleware } from "App/Modules/Bot/Middleware/Middleware";
import { container } from "App/Config/Dependency/Container";
import { Logger } from "App/Services/Logger/Logger";
import { Infrastructure } from "App/Config/Dependency/Symbols/Infrastructure";
import { v4 as uuid } from "uuid";
import { PinoLogger } from "App/Services/Logger/PinoLogger";
import { asyncLocalStorage } from "App/Config/AsyncLocalStorage";

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
