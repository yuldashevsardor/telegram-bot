import { RuntimeError } from "app/shared/errors";

export class UnknownCommand extends RuntimeError {
    public static of(args: readonly string[]): UnknownCommand {
        return new UnknownCommand(
            `There is no command "${args.slice(0, 2).join(" ")}": the first two arguments are <outbox|inbox> <retry|skip>.`,
            {
                args: [...args],
            },
        );
    }
}

export class InvalidCommandArguments extends RuntimeError {
    // expected is how the command writes its arguments, `<chatId>`.
    public static of(args: readonly string[], expected: string): InvalidCommandArguments {
        return new InvalidCommandArguments(`The arguments "${args.join(" ")}" are not ${expected}: the ids are whole numbers.`, {
            args: [...args],
            expected: expected,
        });
    }
}
