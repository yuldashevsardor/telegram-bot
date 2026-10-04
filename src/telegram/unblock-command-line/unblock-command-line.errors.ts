import { RuntimeError } from "app/shared/errors";

export const UNBLOCK_USAGE = [
    "outbox retry <chatId>",
    "outbox skip <chatId>",
    "inbox retry <userId> <chatId>",
    "inbox skip <userId> <chatId>",
].join("; ");

export class InvalidUnblockArguments extends RuntimeError {
    public static of(args: readonly string[]): InvalidUnblockArguments {
        return new InvalidUnblockArguments(
            `Cannot unblock by "${args.join(" ")}": the arguments are one of ${UNBLOCK_USAGE}, the ids whole numbers.`,
            {
                args: [...args],
            },
        );
    }
}
