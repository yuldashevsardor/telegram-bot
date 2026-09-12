import { inject, injectable } from "inversify";
import { NextFunction } from "grammy";
import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { RequestContext } from "app/infrastructure/request-context";
import { Tokens } from "app/common/tokens";
import { Context } from "app/infrastructure/bot/bot.types";

@injectable()
export class RequestContextMiddleware extends Middleware {
    public constructor(
        @inject<RequestContext>(Tokens.Infrastructure.RequestContext)
        private readonly requestContext: RequestContext,
    ) {
        super();
    }

    // Первый из middleware: всё, что логируется внутри цепочки, должно попасть в лог с
    // requestId. Вне области данных запроса нет — ни в фильтрах, которые стоят выше
    // middleware, ни в bot.catch, который вызывается уже после того, как промис пайплайна
    // отклонён.
    public async handle(_context: Context, next: NextFunction): Promise<void> {
        return this.requestContext.run(next);
    }
}
