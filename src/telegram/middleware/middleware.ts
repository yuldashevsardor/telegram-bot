import { Composer, NextFunction } from "grammy";
import { injectable } from "inversify";
import { Context } from "app/infrastructure/bot/bot.types";

@injectable()
export abstract class Middleware {
    protected abstract handle(ctx: Context, next: NextFunction): Promise<unknown>;

    public setup(composer: Composer<Context>): void {
        composer.use(this.handle.bind(this));
    }
}
