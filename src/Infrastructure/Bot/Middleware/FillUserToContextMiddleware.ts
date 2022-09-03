import { Middleware } from "App/Infrastructure/Bot/Middleware/Middleware";
import { Context } from "App/Infrastructure/Bot/Context";
import { NextFunction } from "grammy";
import { inject, injectable } from "inversify";
import { UserService } from "App/Domain/User/UserService";
import { Services } from "App/Infrastructure/Container/Symbols/Services";
import { Logger } from "App/Domain/Logger/Logger";
import { Infrastructure } from "App/Infrastructure/Container/Symbols/Infrastructure";
import { UserRepository } from "App/Domain/User/UserRepository";
import dayjs from "dayjs";

@injectable()
export class FillUserToContextMiddleware extends Middleware {
    public constructor(
        @inject<UserService>(Services.User.UserService) private readonly userService: UserService,
        @inject<UserRepository>(Services.User.UserRepository) private readonly userRepository: UserRepository,
        @inject<Logger>(Infrastructure.Logger) private readonly logger: Logger,
    ) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        if (!ctx.from) {
            this.logger.error("Cannot set user to Context, because ctx.from is empty");

            return;
        }

        if (await this.userRepository.existsById(ctx.from.id)) {
            ctx.user = await this.userService.edit(ctx.from.id, {
                firstname: ctx.from.first_name,
                lastname: ctx.from.last_name || "",
                username: ctx.from.username || "",
                isBot: ctx.from.is_bot,
                lastActiveTime: dayjs(),
            });
        } else {
            ctx.user = await this.userService.create({
                id: ctx.from.id,
                firstname: ctx.from.first_name,
                lastname: ctx.from.last_name || "",
                username: ctx.from.username || "",
                isBot: ctx.from?.is_bot,
            });
        }

        return next();
    }
}
