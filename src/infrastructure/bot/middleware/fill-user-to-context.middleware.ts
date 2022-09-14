import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { NextFunction } from "grammy";
import { inject, injectable } from "inversify";
import { UserService } from "app/domain/user/user.service";
import { Services } from "app/infrastructure/container/symbols/services";
import { Logger } from "app/domain/logger/logger";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { UserRepository } from "app/domain/user/user.repository";
import dayjs from "dayjs";
import { Context } from "app/infrastructure/bot/bot.types";

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
