import { Composer } from "grammy";
import { Context } from "app/infrastructure/bot/bot.types";
import { injectable } from "inversify";

@injectable()
export abstract class Filter {
    protected abstract handle(ctx: Context): boolean;

    public setup(composer: Composer<Context>): void {
        composer.filter(this.handle.bind(this));
    }
}
