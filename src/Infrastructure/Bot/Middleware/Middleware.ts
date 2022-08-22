import { Context } from "App/Infrastructure/Bot/Context";
import { Composer, NextFunction } from "grammy";
import { injectable } from "inversify";

@injectable()
export abstract class Middleware {
    protected abstract handle(ctx: Context, next: NextFunction): Promise<void>;

    public initialize(composer: Composer<Context>): void {
        composer.use(this.handle.bind(this));
    }
}
