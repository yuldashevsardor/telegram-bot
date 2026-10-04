import { InvalidCommandArguments } from "app/cli/cli-command.errors";

// The check of the arguments of a command that takes Telegram ids, the same for every command: the
// command names the ids it expects, in order. A command that takes other arguments needs a check
// of its own.
export class IdArgumentsHelper {
    // The ids by their names, exactly as many as the names. Anything else throws
    // InvalidCommandArguments, with the names written as the command expects them: `<chatId>`.
    public static parse<Name extends string>(args: readonly string[], names: readonly Name[]): Record<Name, number> {
        const expected = names.map((name) => `<${name}>`).join(" ");

        if (args.length !== names.length) {
            throw InvalidCommandArguments.of(args, expected);
        }

        const ids = {} as Record<Name, number>;

        names.forEach((name, index) => {
            ids[name] = IdArgumentsHelper.parseId(args[index] as string, args, expected);
        });

        return ids;
    }

    // A Telegram id: a whole number, negative for a group chat. Number() alone would take "" for 0.
    private static parseId(arg: string, args: readonly string[], expected: string): number {
        if (!/^-?\d+$/.test(arg) || !Number.isSafeInteger(Number(arg))) {
            throw InvalidCommandArguments.of(args, expected);
        }

        return Number(arg);
    }
}
