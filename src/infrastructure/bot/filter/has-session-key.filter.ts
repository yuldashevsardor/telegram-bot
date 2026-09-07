import { injectable } from "inversify";
import { Context } from "app/infrastructure/bot/bot.types";
import { Filter } from "app/infrastructure/bot/filter/filter";
import { getSessionKey } from "app/infrastructure/bot/session/session.helper";

@injectable()
export class HasSessionKeyFilter extends Filter {
    // Тот же getSessionKey, что передан в session(): апдейт без ключа (пост в канале,
    // inline-запрос) сессии не получает, и первое же обращение к ctx.session бросает.
    // Дальше по цепочке такому апдейту делать нечего, поэтому он отбрасывается здесь,
    // до middleware и до любой работы с базой.
    protected handle(ctx: Context): boolean {
        return getSessionKey(ctx) !== undefined;
    }
}
