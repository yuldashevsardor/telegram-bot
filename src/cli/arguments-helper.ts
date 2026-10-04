import { InvalidCommandArguments } from "app/cli/cli-command.errors";

// The type each rule gives to its argument.
type ArgumentValues = { [ArgumentRule.Integer]: number };

// How an argument is read. A new kind of argument is a new rule here, with its type in ArgumentValues.
export enum ArgumentRule {
    // A whole number, negative for the id of a group chat.
    Integer = "integer",
}

export type ArgumentRules = Record<string, ArgumentRule>;

// The arguments by the names the rules gave them, each read by its rule.
export type ParsedArguments<Rules extends ArgumentRules> = { [Name in keyof Rules]: ArgumentValues[Rules[Name]] };

// The check of the arguments of a command, the same for every command: the command names the
// arguments it expects, in order, with the rule of each.
export class ArgumentsHelper {
    // The arguments by their names, exactly as many as the rules. Anything else throws
    // InvalidCommandArguments, with the rules written as the command expects them: `<chatId: integer>`.
    public static parse<Rules extends ArgumentRules>(args: readonly string[], rules: Rules): ParsedArguments<Rules> {
        const entries = Object.entries(rules);
        const expected = entries.map(([name, rule]) => `<${name}: ${rule}>`).join(" ");

        if (args.length !== entries.length) {
            throw InvalidCommandArguments.of(args, expected);
        }

        const parsed: Record<string, number> = {};

        entries.forEach(([name, rule], index) => {
            parsed[name] = ArgumentsHelper.parseByRule(args[index] as string, rule, args, expected);
        });

        // Every name of the rules is in it, with the type its rule gives.
        return parsed as ParsedArguments<Rules>;
    }

    private static parseByRule(arg: string, rule: ArgumentRule, args: readonly string[], expected: string): number {
        switch (rule) {
            case ArgumentRule.Integer:
                return ArgumentsHelper.parseInteger(arg, args, expected);
        }
    }

    // Number() alone would take "" for 0.
    private static parseInteger(arg: string, args: readonly string[], expected: string): number {
        if (!/^-?\d+$/.test(arg) || !Number.isSafeInteger(Number(arg))) {
            throw InvalidCommandArguments.of(args, expected);
        }

        return Number(arg);
    }
}
