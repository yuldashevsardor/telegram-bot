import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { NextFunction } from "grammy";
import { inject, injectable } from "inversify";
import { UserService } from "app/domain/user/user.service";
import { Services } from "app/infrastructure/container/symbols/services";
import { UserRepository } from "app/domain/user/user.repository";
import dayjs from "dayjs";
import { Context } from "app/infrastructure/bot/bot.types";
import { UpdateWithoutFrom } from "app/infrastructure/bot/bot.errors";

@injectable()
export class FillUserToContextMiddleware extends Middleware {
    public constructor(
        @inject<UserService>(Services.User.UserService) private readonly userService: UserService,
        @inject<UserRepository>(Services.User.UserRepository) private readonly userRepository: UserRepository,
    ) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        if (!ctx.from) {
            // Апдейты без from отсеивает HasSessionKeyFilter; проверка здесь нужна
            // компилятору и ловит поломку порядка в Bot.setup().
            throw UpdateWithoutFrom.byUpdate(ctx.update);
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
