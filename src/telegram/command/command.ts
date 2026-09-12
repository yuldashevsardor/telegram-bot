import type { Composer } from "grammy";
import { injectable } from "inversify";
import type { Context } from "app/telegram/bot.types";

@injectable()
export abstract class Command {
    public abstract readonly command: string;
    public abstract readonly descriptionKey: string;

    protected abstract handle(ctx: Context): Promise<void>;

    public setup(composer: Composer<Context>): void {
        composer.command(this.command, this.handle.bind(this));
    }
}
