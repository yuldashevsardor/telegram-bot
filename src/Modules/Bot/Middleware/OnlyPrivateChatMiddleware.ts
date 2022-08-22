import { Middleware } from "App/Modules/Bot/Middleware/Middleware";
import { inject, injectable } from "inversify";
import { Logger } from "App/Services/Logger/Logger";
import { Infrastructure } from "App/Config/Dependency/Symbols/Infrastructure";
import { Context } from "App/Modules/Bot/Context";
import { NextFunction } from "grammy";

@injectable()
export class OnlyPrivateChatMiddleware extends Middleware {
    public constructor(@inject<Logger>(Infrastructure.Logger) private readonly logger: Logger) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        if (ctx.chat?.type !== "private") {
            this.logger.warning("Is not private chat...");

            return;
        }

        return next();
    }
}
