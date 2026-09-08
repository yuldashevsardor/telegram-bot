import { inject, injectable } from "inversify";
import { NextFunction } from "grammy";
import { AsyncLocalStorage } from "async_hooks";
import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { v4 as uuid } from "uuid";
import { ALS_KEYS, AlsStore } from "app/infrastructure/async-local-storage.types";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { Context } from "app/infrastructure/bot/bot.types";

@injectable()
export class AsyncLocalStorageMiddleware extends Middleware {
    public constructor(
        @inject<AsyncLocalStorage<AlsStore>>(Infrastructure.Als)
        private readonly asyncLocalStorage: AsyncLocalStorage<AlsStore>,
    ) {
        super();
    }

    // Первый в пайплайне: всё, что логируется внутри цепочки, должно попасть в лог с
    // requestId. Вне области run() данных запроса нет — в том числе в bot.catch, который
    // вызывается уже после того, как промис пайплайна отклонён.
    public async handle(_context: Context, next: NextFunction): Promise<void> {
        return this.asyncLocalStorage.run({ [ALS_KEYS.REQUEST_ID]: uuid() }, next);
    }
}
