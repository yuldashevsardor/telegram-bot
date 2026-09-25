import type { Composer, NextFunction } from "grammy";
import type { Context } from "app/telegram/bot/bot.types";
import { inject, injectable } from "inversify";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";

@injectable()
export abstract class Filter {
    // The logger lives in the base, not in the subclasses: the decision to drop is taken here,
    // so its trace stays here too. Otherwise every new filter would drop silently until its
    // author remembered the logger.
    public constructor(@inject<Logger>(Tokens.Bootstrap.Logger) protected readonly logger: Logger) {}

    protected abstract handle(ctx: Context): boolean;

    // Not composer.filter(): it does not drop the update, it only puts the condition in front of
    // what is attached to the composer it returns. Nobody here needs that composer, and the
    // chain must break, so we call next() ourselves, or do not.
    public setup(composer: Composer<Context>): void {
        composer.use((ctx: Context, next: NextFunction): Promise<void> => {
            if (!this.handle(ctx)) {
                this.logger.debug("Update is dropped by filter.", {
                    filter: this.constructor.name,
                    updateId: ctx.update.update_id,
                });

                return Promise.resolve();
            }

            return next();
        });
    }
}
