import { Composer, NextFunction } from "grammy";
import { Context } from "app/infrastructure/bot/bot.types";
import { injectable } from "inversify";

@injectable()
export abstract class Filter {
    protected abstract handle(ctx: Context): boolean;

    // Не composer.filter(): он не отбрасывает апдейт, а прячет за условием только то,
    // что повешено на возвращённый им composer. Здесь возвращённый composer никому не
    // нужен, а цепочку обрывать надо, поэтому next() зовём сами — или не зовём.
    public setup(composer: Composer<Context>): void {
        composer.use((ctx: Context, next: NextFunction): Promise<void> => {
            if (!this.handle(ctx)) {
                return Promise.resolve();
            }

            return next();
        });
    }
}
