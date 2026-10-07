import type { Chat, User } from "grammy/types";
import type { SessionPayload } from "app/telegram/session/session.types";
import type { Context } from "app/telegram/bot/bot.types";

export function initialPayload(): SessionPayload {
    return {
        requestCount: 0,
    };
}

// The user and the chat the session key is made of: an update without either has no session. The
// polling source of the inbox reads the group of an update by the same rule.
export function hasSessionKey<C extends { from: User | undefined; chat: Chat | undefined }>(ctx: C): ctx is C & { from: User; chat: Chat } {
    return ctx.from !== undefined && ctx.chat !== undefined;
}

export function getSessionKey(ctx: Omit<Context, "session">): string | undefined {
    if (!hasSessionKey(ctx)) {
        return undefined;
    }

    return `${ctx.from.id}:${ctx.chat.id}`;
}
