import { SessionPayload } from "app/infrastructure/bot/session/session.types";
import { Context } from "app/infrastructure/bot/bot.types";

export function initialPayload(): SessionPayload {
    return {
        requestCount: 0,
    };
}

export function getSessionKey(ctx: Context): string | undefined {
    if (ctx.from === undefined || ctx.chat === undefined) {
        return undefined;
    }

    return `${ctx.from.id}:${ctx.chat.id}`;
}
