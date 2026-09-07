import { inject, injectable } from "inversify";
import { Context } from "app/infrastructure/bot/bot.types";
import { Filter } from "app/infrastructure/bot/filter/filter";
import { getSessionKey } from "app/infrastructure/bot/session/session.helper";
import { Logger } from "app/domain/logger/logger";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";

@injectable()
export class HasSessionKeyFilter extends Filter {
    public constructor(@inject<Logger>(Infrastructure.Logger) private readonly logger: Logger) {
        super();
    }

    // Тот же getSessionKey, что передан в session(): апдейт без ключа (пост в канале,
    // inline-запрос) сессии не получает, и первое же обращение к ctx.session бросает.
    // Дальше по цепочке такому апдейту делать нечего, поэтому он отбрасывается здесь,
    // до middleware и до любой работы с базой.
    protected handle(ctx: Context): boolean {
        if (getSessionKey(ctx) !== undefined) {
            return true;
        }

        // Единственный след отброшенного апдейта: RequestLogMiddleware с его дампом
        // update стоит ниже. Содержимое апдейта в лог не идёт — только чего в нём нет.
        this.logger.warning("Update is dropped, because its session key cannot be resolved.", {
            updateId: ctx.update.update_id,
            hasFrom: ctx.from !== undefined,
            hasChat: ctx.chat !== undefined,
        });

        return false;
    }
}
