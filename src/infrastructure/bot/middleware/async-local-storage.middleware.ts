import { injectable } from "inversify";
import { NextFunction } from "grammy";
import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { v4 as uuid } from "uuid";
import { asyncLocalStorage } from "app/infrastructure/async-local-storage";
import { ALS_KEYS } from "app/infrastructure/async-local-storage.types";
import { Context } from "app/infrastructure/bot/bot.types";

@injectable()
export class AsyncLocalStorageMiddleware extends Middleware {
    // Первый в пайплайне: всё, что логируется внутри цепочки, должно попасть в лог с
    // requestId. Вне области run() данных запроса нет — в том числе в bot.catch, который
    // вызывается уже после того, как промис пайплайна отклонён.
    public async handle(_context: Context, next: NextFunction): Promise<void> {
        return asyncLocalStorage.run({ [ALS_KEYS.REQUEST_ID]: uuid() }, next);
    }
}
