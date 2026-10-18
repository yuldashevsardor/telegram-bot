import { inject, injectable } from "inversify";
import type { NextFunction } from "grammy";
import { Tokens } from "app/shared/tokens";
import { Middleware } from "app/telegram/middleware/middleware";
import type { Context } from "app/telegram/bot/bot.types";
import type { HelpCommand } from "app/telegram/command/help/help.command";

// Stands after the commands, so a command it sees matched none of them.
@injectable()
export class UnknownCommandMiddleware extends Middleware {
    public constructor(@inject<HelpCommand>(Tokens.Bot.Command.Help) private readonly helpCommand: HelpCommand) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        if (!this.isCommand(ctx)) {
            return next();
        }

        await this.helpCommand.handle(ctx);
    }

    // A command opens the text, as grammY's command() takes it; "/start" in the middle of a text is
    // not one.
    private isCommand(ctx: Context): boolean {
        const entities = ctx.message?.entities ?? [];

        return entities.some((entity) => entity.type === "bot_command" && entity.offset === 0);
    }
}
