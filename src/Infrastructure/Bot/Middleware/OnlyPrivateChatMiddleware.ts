import { Middleware } from "App/Infrastructure/Bot/Middleware/Middleware";
import { inject, injectable } from "inversify";
import { Logger } from "App/Domain/Logger/Logger";
import { Infrastructure } from "App/Infrastructure/Container/Symbols/Infrastructure";
import { NextFunction } from "grammy";
import { Context } from "App/Infrastructure/Bot/Types";

@injectable()
export class OnlyPrivateChatMiddleware extends Middleware {
    public constructor(@inject<Logger>(Infrastructure.Logger) private readonly logger: Logger) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        if (ctx.chat?.type !== "private") {
            this.logger.warning("It is not private chat, skip...");

            return;
        }

        return next();
    }
}
