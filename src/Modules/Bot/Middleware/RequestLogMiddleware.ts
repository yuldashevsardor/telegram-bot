import { inject, injectable } from "inversify";
import { Infrastructure } from "App/Config/Dependency/Symbols/Infrastructure";
import { Logger } from "App/Services/Logger/Logger";
import { Context } from "App/Modules/Bot/Context";
import { NextFunction } from "grammy";
import { Middleware } from "App/Modules/Bot/Middleware/Middleware";

@injectable()
export class RequestLogMiddleware extends Middleware {
    public constructor(@inject<Logger>(Infrastructure.Logger) private readonly logger: Logger) {
        super();
    }

    public async handle(context: Context, next: NextFunction): Promise<void> {
        this.logger.debug("Request", context.update);

        return next();
    }
}
