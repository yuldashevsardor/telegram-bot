import { expect } from "chai";
import { InvalidCommandArguments } from "app/cli/cli-command.errors";
import { ArgumentRule, ArgumentsHelper } from "app/cli/arguments-helper";

const CHAT = { chatId: ArgumentRule.Integer };
const GROUP = { userId: ArgumentRule.Integer, chatId: ArgumentRule.Integer };
const GROUP_EXPECTED = "<userId: integer> <chatId: integer>";

describe("ArgumentsHelper", function () {
    it("reads the arguments by the names and the rules the command gave, a negative id of a group included", function () {
        expect(ArgumentsHelper.parse(["-1001234567890"], CHAT)).to.deep.equal({ chatId: -1_001_234_567_890 });
        expect(ArgumentsHelper.parse(["5000000001", "-42"], GROUP)).to.deep.equal({ userId: 5_000_000_001, chatId: -42 });
    });

    const refused: Array<[string, string[]]> = [
        ["no arguments", []],
        ["two arguments for one name", ["1", "2"]],
        ["an empty integer", [""]],
        ["an integer that is not a number", ["chat"]],
        ["an integer with a fraction", ["1.5"]],
        ["an integer with a sign after the digits", ["1-"]],
        ["an integer with a letter before the digits", ["a1"]],
        ["an integer beyond the safe integers", ["9007199254740993"]],
    ];

    for (const [name, args] of refused) {
        it(`refuses ${name} and writes what the command expects`, function () {
            expectInvalid(() => ArgumentsHelper.parse(args, CHAT), args, "<chatId: integer>");
        });
    }

    it("refuses one argument and three arguments for two names", function () {
        expectInvalid(() => ArgumentsHelper.parse(["1"], GROUP), ["1"], GROUP_EXPECTED);
        expectInvalid(() => ArgumentsHelper.parse(["1", "2", "3"], GROUP), ["1", "2", "3"], GROUP_EXPECTED);
    });

    it("refuses a second argument that is not a number", function () {
        expectInvalid(() => ArgumentsHelper.parse(["1", "x"], GROUP), ["1", "x"], GROUP_EXPECTED);
    });
});

function expectInvalid(validate: () => unknown, args: string[], expected: string): void {
    let error: unknown;

    try {
        validate();
    } catch (reason) {
        error = reason;
    }

    expect(error).to.be.instanceOf(InvalidCommandArguments);
    expect((error as InvalidCommandArguments).payload).to.deep.equal({ args: args, expected: expected });
    expect((error as InvalidCommandArguments).message).to.equal(`The arguments "${args.join(" ")}" are not ${expected}.`);
}
