import { Middleware } from "app/telegram/middleware/middleware";
import { NextFunction } from "grammy";
import { inject, injectable } from "inversify";
import { UserService } from "app/telegram/user/user.service";
import { Tokens } from "app/common/tokens";
import { UserRepository } from "app/telegram/user/user.repository";
import { User } from "app/telegram/user/user";
import dayjs from "dayjs";
import { Context } from "app/telegram/bot.types";
import { UpdateWithoutFrom } from "app/telegram/bot.errors";

@injectable()
export class FillUserToContextMiddleware extends Middleware {
    public constructor(
        @inject<UserService>(Tokens.User.Service) private readonly userService: UserService,
        @inject<UserRepository>(Tokens.User.Repository) private readonly userRepository: UserRepository,
    ) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        if (!ctx.from) {
            // Апдейты без from отсеивает HasSessionKeyFilter; проверка здесь нужна
            // компилятору и ловит поломку порядка в Bot.setup().
            throw UpdateWithoutFrom.byUpdate(ctx.update);
        }

        let user: User;

        if (await this.userRepository.existsById(ctx.from.id)) {
            user = await this.userService.edit(ctx.from.id, {
                firstname: ctx.from.first_name,
                lastname: ctx.from.last_name || "",
                username: ctx.from.username || "",
                isBot: ctx.from.is_bot,
                lastActiveTime: dayjs(),
            });
        } else {
            user = await this.userService.create({
                id: ctx.from.id,
                firstname: ctx.from.first_name,
                lastname: ctx.from.last_name || "",
                username: ctx.from.username || "",
                isBot: ctx.from?.is_bot,
            });
        }

        // Функция, а не поле: перечислимое свойство контекста плагин разговоров клонирует
        // в op-лог и в sessions (docs/architecture/invariants.md), а клон User — пустой
        // объект, у него всё в приватных полях. Функции плагин не клонирует, а
        // восстанавливает биндом от живого контекста, поэтому внутри разговора getUser()
        // отдаёт пользователя текущего апдейта, а не слепок с момента входа в разговор.
        ctx.getUser = (): User => user;

        return next();
    }
}
