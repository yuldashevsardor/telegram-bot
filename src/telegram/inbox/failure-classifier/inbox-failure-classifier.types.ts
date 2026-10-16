// The classes of an error an update handler fails with, by what the inbox does with the update
// (docs/architecture/inbox.md, "Error classes").
export enum InboxFailureKind {
    // The handler may pass on a retry: Telegram, the network or the database failed for a while.
    Transient = "transient",
    // The chat cannot get the reply at all: a retry would fail the same way, and the next update of
    // the group must not wait behind this one.
    Undeliverable = "undeliverable",
    // The wait for the result of an outbox message ran out: the reply stays in the outbox and may
    // still go out, a retry would send it a second time, and the next update of the group must not
    // wait behind this one.
    ReplyTimeout = "reply_timeout",
    // Anything else, a bug included: nothing says a retry would help.
    Unexpected = "unexpected",
}
