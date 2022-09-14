import { inject, injectable } from "inversify";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { Logger } from "app/domain/logger/logger";
import { NextFunction } from "grammy";
import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { Context } from "app/infrastructure/bot/bot.types";

@injectable()
export class ResponseTimeMiddleware extends Middleware {
    public constructor(@inject<Logger>(Infrastructure.Logger) private readonly logger: Logger) {
        super();
    }

    public async handle(context: Context, next: NextFunction): Promise<void> {
        const start = Date.now();
        await next();
        const end = Date.now();

        this.logger.info(`Response time: ${end - start} ms`);
    }
}
