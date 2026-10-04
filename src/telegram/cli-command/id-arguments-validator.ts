import { InvalidCommandArguments } from "app/telegram/cli-command/cli-command.errors";

// The base of the validators of the commands whose arguments are Telegram ids. A command that takes
// other arguments has a validator of its own.
export abstract class IdArgumentsValidator {
    // expected is how the arguments are written, `<chatId>`.
    protected constructor(private readonly expected: string) {}

    // The ids of args, exactly count of them. Anything else throws InvalidCommandArguments.
    protected parseIds(args: readonly string[], count: number): number[] {
        if (args.length !== count) {
            throw InvalidCommandArguments.of(args, this.expected);
        }

        return args.map((arg) => this.parseId(arg, args));
    }

    // A Telegram id: a whole number, negative for a group chat. Number() alone would take "" for 0.
    private parseId(arg: string, args: readonly string[]): number {
        if (!/^-?\d+$/.test(arg) || !Number.isSafeInteger(Number(arg))) {
            throw InvalidCommandArguments.of(args, this.expected);
        }

        return Number(arg);
    }
}
