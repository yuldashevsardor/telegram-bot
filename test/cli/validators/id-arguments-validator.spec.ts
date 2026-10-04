import { expect } from "chai";
import { InvalidCommandArguments } from "app/cli/cli-command.errors";
import { IdArgumentsValidator } from "app/cli/validators/id-arguments-validator";

describe("IdArgumentsValidator", function () {
    const validator = new IdArgumentsValidator();

    it("reads the ids by the names the command gave, a negative id of a group included", function () {
        expect(validator.validate(["-1001234567890"], ["chatId"])).to.deep.equal({ chatId: -1_001_234_567_890 });
        expect(validator.validate(["5000000001", "-42"], ["userId", "chatId"])).to.deep.equal({ userId: 5_000_000_001, chatId: -42 });
    });

    const refused: Array<[string, string[]]> = [
        ["no arguments", []],
        ["two ids for one name", ["1", "2"]],
        ["an empty id", [""]],
        ["an id that is not a number", ["chat"]],
        ["an id with a fraction", ["1.5"]],
        ["an id with a sign after the digits", ["1-"]],
        ["an id with a letter before the digits", ["a1"]],
        ["an id beyond the safe integers", ["9007199254740993"]],
    ];

    for (const [name, args] of refused) {
        it(`refuses ${name} and writes the names the command expects`, function () {
            expectInvalid(() => validator.validate(args, ["chatId"]), args, "<chatId>");
        });
    }

    it("refuses one id and three ids for two names", function () {
        expectInvalid(() => validator.validate(["1"], ["userId", "chatId"]), ["1"], "<userId> <chatId>");
        expectInvalid(() => validator.validate(["1", "2", "3"], ["userId", "chatId"]), ["1", "2", "3"], "<userId> <chatId>");
    });

    it("refuses a second id that is not a number", function () {
        expectInvalid(() => validator.validate(["1", "x"], ["userId", "chatId"]), ["1", "x"], "<userId> <chatId>");
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
    expect((error as InvalidCommandArguments).message).to.equal(
        `The arguments "${args.join(" ")}" are not ${expected}: the ids are whole numbers.`,
    );
}
