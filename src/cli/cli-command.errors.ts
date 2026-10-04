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
    // expected is how the command writes its arguments, `<chatId: integer>`.
    public static of(args: readonly string[], expected: string): InvalidCommandArguments {
        return new InvalidCommandArguments(`The arguments "${args.join(" ")}" are not ${expected}.`, {
            args: [...args],
            expected: expected,
        });
    }
}

export class UnsupportedArgumentRule extends RuntimeError {
    public static of(rule: unknown): UnsupportedArgumentRule {
        return new UnsupportedArgumentRule(`There is no rule to read an argument by "${String(rule)}".`, { rule: String(rule) });
    }
}
