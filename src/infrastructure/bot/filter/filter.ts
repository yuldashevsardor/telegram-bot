import { Composer, NextFunction } from "grammy";
import { Context } from "app/infrastructure/bot/bot.types";
import { inject, injectable } from "inversify";
import { Logger } from "app/domain/logger/logger";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";

@injectable()
export abstract class Filter {
    // Логгер в базе, а не в наследниках: решение об отбросе принимается здесь, значит и
    // след о нём остаётся здесь — иначе каждый новый фильтр молчал бы, пока автор не
    // вспомнит про логгер.
    public constructor(@inject<Logger>(Infrastructure.Logger) protected readonly logger: Logger) {}

    protected abstract handle(ctx: Context): boolean;

    // Не composer.filter(): он не отбрасывает апдейт, а прячет за условием только то,
    // что повешено на возвращённый им composer. Здесь возвращённый composer никому не
    // нужен, а цепочку обрывать надо, поэтому next() зовём сами — или не зовём.
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
