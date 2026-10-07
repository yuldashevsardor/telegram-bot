import type postgres from "postgres";
import { RuntimeError } from "app/shared/errors";

export class InvalidClaimLimit extends RuntimeError {
    public static of(limit: number): InvalidClaimLimit {
        return new InvalidClaimLimit(`An inbox claim of ${limit} updates is not a whole number from 1 to Number.MAX_SAFE_INTEGER.`, {
            limit: limit,
        });
    }
}

export class InboxGroupNotBlocked extends RuntimeError {
    public static byGroup(userId: number, chatId: number): InboxGroupNotBlocked {
        return new InboxGroupNotBlocked(
            `Inbox group (${userId}, ${chatId}) is not blocked by a failed update: only a blocked group with its failed update can be unblocked.`,
            {
                userId: userId,
                chatId: chatId,
            },
        );
    }
}

export class InboxUpdateNotLeased extends RuntimeError {
    public static byId(updateId: number): InboxUpdateNotLeased {
        return new InboxUpdateNotLeased(
            `Inbox update ${updateId} is not the update its lease holds: the id is missing or names another update of the leased group.`,
            {
                updateId: updateId,
            },
        );
    }
}

// A push PostgreSQL failed, by the code, message and detail of its error, not the error as a whole:
// the CONTEXT it gives a refused value, in its where field, holds the update up to that value, the
// text of the message included.
export class InboxPushFailed extends RuntimeError {
    public static byPostgresError<T extends InboxPushFailed>(
        this: new (...params: ConstructorParameters<typeof RuntimeError>) => T,
        error: postgres.PostgresError,
    ): T {
        return new this(error.message, { code: error.code, detail: error.detail });
    }
}

// A push PostgreSQL failed for a value of the updates themselves: the same updates fail every time
// they are pushed (docs/architecture/inbox.md, "The polling source").
export class InboxUpdateRefused extends InboxPushFailed {}
