import { Context } from "App/Infrastructure/Bot/Context";
import { Composer } from "grammy";
import { injectable } from "inversify";

@injectable()
export abstract class Command {
    protected abstract readonly command: string;

    protected abstract handle(ctx: Context): Promise<void>;

    public initialize(composer: Composer<Context>): void {
        composer.command(this.command, this.handle.bind(this));
    }
}
