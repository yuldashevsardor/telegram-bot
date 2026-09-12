import { injectable } from "inversify";
import type { Context } from "app/telegram/bot.types";
import { Filter } from "app/telegram/filter/filter";
import { getSessionKey } from "app/telegram/session/session.helper";

@injectable()
export class HasSessionKeyFilter extends Filter {
    // Тот же getSessionKey, что передан в session(): апдейт без ключа сессии не
    // получает, и первое же обращение к ctx.session бросает. Дальше по цепочке такому
    // апдейту делать нечего, поэтому он отбрасывается здесь, до middleware и до любой
    // работы с базой. С allowed_updates = ["message"] апдейты без from или chat уже не
    // запрашиваются, так что сюда доходят только остатки старых типов после смены
    // списка — событие редкое, и warning ниже означает именно неожиданное.
    protected handle(ctx: Context): boolean {
        if (getSessionKey(ctx) !== undefined) {
            return true;
        }

        // Сверх общей строки базового Filter: у неё уровень debug и нет деталей, а
        // здесь важно и то, чего в апдейте не хватило. Содержимое апдейта в лог не идёт.
        this.logger.warning("Update is dropped, because its session key cannot be resolved.", {
            updateId: ctx.update.update_id,
            hasFrom: ctx.from !== undefined,
            hasChat: ctx.chat !== undefined,
        });

        return false;
    }
}
