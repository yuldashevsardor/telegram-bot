import { injectable } from "inversify";
import type { Context } from "app/telegram/bot/bot.types";
import { Filter } from "app/telegram/filter/filter";
import { getSessionKey } from "app/telegram/session/session.helper";

@injectable()
export class HasSessionKeyFilter extends Filter {
    // The same getSessionKey that is passed to session(): an update without a session key gets
    // none, and the very first touch of ctx.session throws. Such an update has nothing to do
    // further down the chain, so it is dropped here, before the middleware and before any work
    // with the database. With allowed_updates = ["message"] updates without from or chat are no
    // longer requested, so only the leftovers of the old types after a change of the list reach
    // this point — a rare event, and the warning below means exactly "unexpected".
    protected handle(ctx: Context): boolean {
        if (getSessionKey(ctx) !== undefined) {
            return true;
        }

        // On top of the common line of the base Filter: that one is debug and carries no
        // details, while here what the update was missing matters too. The contents of the
        // update do not go to the log.
        this.logger.warning("Update is dropped, because its session key cannot be resolved.", {
            updateId: ctx.update.update_id,
            hasFrom: ctx.from !== undefined,
            hasChat: ctx.chat !== undefined,
        });

        return false;
    }
}
