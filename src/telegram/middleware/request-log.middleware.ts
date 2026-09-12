import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { Logger } from "app/platform/logger/logger";
import { NextFunction } from "grammy";
import { Middleware } from "app/telegram/middleware/middleware";
import { Context } from "app/telegram/bot.types";

@injectable()
export class RequestLogMiddleware extends Middleware {
    public constructor(@inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger) {
        super();
    }

    public async handle(context: Context, next: NextFunction): Promise<void> {
        context.session.requestCount++;
        this.logger.debug("Request", { update: context.update });

        return next();
    }
}
