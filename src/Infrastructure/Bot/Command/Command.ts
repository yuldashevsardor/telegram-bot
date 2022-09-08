import { Composer } from "grammy";
import { injectable } from "inversify";
import { Context } from "App/Infrastructure/Bot/Types";

@injectable()
export abstract class Command {
    public abstract readonly command: string;
    public abstract readonly description: string;

    protected abstract handle(ctx: Context): Promise<void>;

    public setup(composer: Composer<Context>): void {
        composer.command(this.command, this.handle.bind(this));
    }
}
