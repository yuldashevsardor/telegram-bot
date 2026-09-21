import { Middleware } from "app/telegram/middleware/middleware";
import type { NextFunction } from "grammy";
import { inject, injectable } from "inversify";
import type { UserService } from "app/telegram/user/service/user-service";
import { Tokens } from "app/shared/tokens";
import type { UserRepository } from "app/telegram/user/user-repository";
import type { User } from "app/telegram/user/user";
import dayjs from "dayjs";
import type { Context } from "app/telegram/bot/bot.types";
import { UpdateWithoutFrom } from "app/telegram/bot/bot.errors";

@injectable()
export class FillUserToContextMiddleware extends Middleware {
    public constructor(
        @inject<UserService>(Tokens.Bot.User.Service) private readonly userService: UserService,
        @inject<UserRepository>(Tokens.Bot.User.Repository) private readonly userRepository: UserRepository,
    ) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        if (!ctx.from) {
            // Updates without from are cut off by HasSessionKeyFilter; the check here is for
            // the compiler and catches a broken order in Bot.setup().
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
                // Stryker disable next-line OptionalChaining: `ctx.from.is_bot` is equivalent: an update without from is rejected at the start of handle()
                isBot: ctx.from?.is_bot,
            });
        }

        // A function, not a field: an enumerable context property is cloned by the conversations
        // plugin into the op log and into sessions (docs/architecture/invariants.md), and a clone
        // of User is an empty object — everything in it sits in private fields. Functions the
        // plugin does not clone but restores by binding to the live context, so inside a
        // conversation getUser() gives the user of the current update, not a snapshot taken when
        // the conversation was entered.
        ctx.getUser = (): User => user;

        return next();
    }
}
