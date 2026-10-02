import { RuntimeError } from "app/shared/errors";

export class InvalidClaimLimit extends RuntimeError {
    public static of(limit: number): InvalidClaimLimit {
        return new InvalidClaimLimit(`An inbox claim of ${limit} updates is not a whole number from 1 to Number.MAX_SAFE_INTEGER.`, {
            limit: limit,
        });
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
