import { Context } from "App/Modules/Bot/Context";
import { Composer } from "grammy";
import { injectable } from "inversify";

@injectable()
export abstract class Command {
    protected abstract readonly command: string;

    protected abstract handler(ctx: Context): Promise<void>;

    public async initialize(composer: Composer<Context>): Promise<void> {
        composer.command(this.command, this.handler.bind(this));
    }
}
