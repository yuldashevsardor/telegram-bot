import { inject, injectable } from "inversify";
import type { NextFunction } from "grammy";
import { Middleware } from "app/telegram/middleware/middleware";
import type { RequestContext } from "app/platform/request-context/request-context";
import { Tokens } from "app/shared/tokens";
import type { Context } from "app/telegram/bot/bot.types";

@injectable()
export class RequestContextMiddleware extends Middleware {
    public constructor(
        @inject<RequestContext>(Tokens.Bootstrap.RequestContext)
        private readonly requestContext: RequestContext,
    ) {
        super();
    }

    // The first of the middleware: everything logged inside the chain has to carry a requestId.
    // The filters above the middleware and grammy.catch run outside the scope and get no request
    // data (docs/architecture/logging.md).
    public async handle(_context: Context, next: NextFunction): Promise<void> {
        return this.requestContext.run(next);
    }
}
