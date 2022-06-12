import { inject, injectable } from "inversify";
import { Infrastructure } from "App/Config/Dependency/Symbols/Infrastructure";
import { Logger } from "App/Services/Logger/Logger";
import { Context } from "App/Modules/Bot/Context";
import { NextFunction } from "grammy";
import { Middleware } from "App/Modules/Bot/Middleware/Middleware";

@injectable()
export class ResponseTimeMiddleware extends Middleware {
    public constructor(@inject<Logger>(Infrastructure.Logger) private readonly logger: Logger) {
        super();
    }

    public async handle(context: Context, next: NextFunction): Promise<void> {
        this.logger.debug("Update:", context.update);

        const start = Date.now();
        await next();
        const end = Date.now();

        this.logger.info(`Response time: ${end - start} ms`);
    }
}
