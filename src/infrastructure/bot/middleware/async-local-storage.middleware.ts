import { injectable } from "inversify";
import { NextFunction } from "grammy";
import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { v4 as uuid } from "uuid";
import { AlsKey, runWithAlsStore } from "app/infrastructure/async-local-storage";
import { Context } from "app/infrastructure/bot/bot.types";

@injectable()
export class AsyncLocalStorageMiddleware extends Middleware {
    // Первый в пайплайне: всё, что логируется ниже, должно попасть в лог с requestId.
    public async handle(_context: Context, next: NextFunction): Promise<void> {
        return runWithAlsStore({ [AlsKey.RequestId]: uuid() }, next);
    }
}
