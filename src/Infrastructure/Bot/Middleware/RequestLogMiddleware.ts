import { inject, injectable } from "inversify";
import { Infrastructure } from "App/Infrastructure/Container/Symbols/Infrastructure";
import { Logger } from "App/Domain/Logger/Logger";
import { NextFunction } from "grammy";
import { Middleware } from "App/Infrastructure/Bot/Middleware/Middleware";
import { Context } from "App/Infrastructure/Bot/Types";

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
