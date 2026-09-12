import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { Logger } from "app/shared/logger";
import { NextFunction } from "grammy";
import { Middleware } from "app/telegram/middleware/middleware";
import { Context } from "app/telegram/bot.types";

@injectable()
export class ResponseTimeMiddleware extends Middleware {
    public constructor(@inject<Logger>(Tokens.Platform.Logger) private readonly logger: Logger) {
        super();
    }

    public async handle(_context: Context, next: NextFunction): Promise<void> {
        const start = Date.now();
        await next();
        const end = Date.now();

        this.logger.info(`Response time: ${end - start} ms`);
    }
}
