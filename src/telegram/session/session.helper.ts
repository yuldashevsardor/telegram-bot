import type { SessionPayload } from "app/telegram/session/session.types";
import type { Context } from "app/telegram/bot.types";

export function initialPayload(): SessionPayload {
    return {
        requestCount: 0,
    };
}

export function getSessionKey(ctx: Omit<Context, "session">): string | undefined {
    if (ctx.from === undefined || ctx.chat === undefined) {
        return undefined;
    }

    return `${ctx.from.id}:${ctx.chat.id}`;
}
