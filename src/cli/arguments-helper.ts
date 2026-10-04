import { InvalidCommandArguments, UnsupportedArgumentRule } from "app/cli/cli-command.errors";

// The type each rule gives to its argument.
type ArgumentValues = { [ArgumentRule.Integer]: number };

// How an argument is read. A new kind of argument is a new rule here, with its type in ArgumentValues.
export enum ArgumentRule {
    // A whole number, negative for the id of a group chat.
    Integer = "integer",
}

// One argument of a command: its name and the rule it is read by.
export type ArgumentSpec = {
    name: string;
    rule: ArgumentRule;
};

// The arguments by the names the specs gave them, each read by its rule.
export type ParsedArguments<Specs extends readonly ArgumentSpec[]> = {
    [Spec in Specs[number] as Spec["name"]]: ArgumentValues[Spec["rule"]];
};

// The check of the arguments of a command, the same for every command: the command lists the
// arguments it expects in an array, so the order is the one written, and the rule of each.
export class ArgumentsHelper {
    // The arguments by their names, exactly as many as the specs. Anything else throws
    // InvalidCommandArguments, with the specs written as the command expects them: `<chatId: integer>`.
    public static parse<const Specs extends readonly ArgumentSpec[]>(args: readonly string[], specs: Specs): ParsedArguments<Specs> {
        const expected = specs.map((spec) => `<${spec.name}: ${spec.rule}>`).join(" ");

        if (args.length !== specs.length) {
            throw InvalidCommandArguments.of(args, expected);
        }

        const parsed: Record<string, ArgumentValues[ArgumentRule]> = {};

        specs.forEach((spec, index) => {
            parsed[spec.name] = ArgumentsHelper.parseByRule(args[index] as string, spec.rule, args, expected);
        });

        // Every name of the specs is in it, with the type its rule gives.
        return parsed as ParsedArguments<Specs>;
    }

    private static parseByRule(arg: string, rule: ArgumentRule, args: readonly string[], expected: string): ArgumentValues[ArgumentRule] {
        switch (rule) {
            case ArgumentRule.Integer:
                return ArgumentsHelper.parseInteger(arg, args, expected);
            default:
                // Not reachable while the types hold: a rule from outside the enum, through a cast,
                // would be read as nothing and leave the argument undefined.
                throw UnsupportedArgumentRule.of(rule);
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
