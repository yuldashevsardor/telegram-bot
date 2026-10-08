import { injectable } from "inversify";
import type { Context } from "app/telegram/bot/bot.types";
import { Filter } from "app/telegram/filter/filter";
import { getSessionKey } from "app/telegram/session/session.helper";

@injectable()
export class HasSessionKeyFilter extends Filter {
    // The same getSessionKey that session() gets: an update without a key has no session, and its
    // first touch of ctx.session throws, so it is dropped before the middleware and the database.
    // None is expected: ALLOWED_UPDATES requests none, and the polling source of the inbox drops one
    // before the push, so the warning below means "unexpected" (docs/architecture/bot.md, step 1).
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
