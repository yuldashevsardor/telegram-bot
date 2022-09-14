import { inject, injectable } from "inversify";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { Logger } from "app/domain/logger/logger";
import { NextFunction } from "grammy";
import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { Context } from "app/infrastructure/bot/bot.types";

@injectable()
export class RequestLogMiddleware extends Middleware {
    public constructor(@inject<Logger>(Infrastructure.Logger) private readonly logger: Logger) {
        super();
    }

    public async handle(context: Context, next: NextFunction): Promise<void> {
        context.session.requestCount++;
        this.logger.debug("Request", context.update);

        return next();
    }
}
