import { injectable } from "inversify";
import type { Context } from "app/telegram/bot/bot.types";
import { Filter } from "app/telegram/filter/filter";
import { getSessionKey } from "app/telegram/session/session.helper";

@injectable()
export class HasSessionKeyFilter extends Filter {
    // The same getSessionKey that is passed to session(). An update without a session key gets
    // no session, and its first touch of ctx.session throws. It has nothing to do further down
    // the chain, so it is dropped here, before the middleware and before any work with the
    // database. allowed_updates = ["message"] no longer requests updates without from or chat:
    // only leftovers of the old types after a change of the list get here. That is rare, and the
    // warning below means exactly "unexpected".
    protected handle(ctx: Context): boolean {
        if (getSessionKey(ctx) !== undefined) {
            return true;
        }

        // On top of the common debug line of the base Filter, which has no details: here what
        // the update was missing matters too. The contents of the update stay out of the log.
        this.logger.warning("Update is dropped, because its session key cannot be resolved.", {
            updateId: ctx.update.update_id,
            hasFrom: ctx.from !== undefined,
            hasChat: ctx.chat !== undefined,
        });

        return false;
    }
}
