import { SessionPayload } from "App/Infrastructure/Bot/Session/Types";
import { Context } from "App/Infrastructure/Bot/Types";

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
