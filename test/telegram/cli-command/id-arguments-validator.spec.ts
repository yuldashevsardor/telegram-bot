import { expect } from "chai";
import { InvalidCommandArguments } from "app/telegram/cli-command/cli-command.errors";
import { OutboxArgumentsValidator } from "app/telegram/outbox/command/outbox-arguments-validator";
import { InboxArgumentsValidator } from "app/telegram/inbox/command/inbox-arguments-validator";

// The base class has no instance: it is pinned through the two validators that extend it.
describe("IdArgumentsValidator", function () {
    const outbox = new OutboxArgumentsValidator();
    const inbox = new InboxArgumentsValidator();

    it("reads the chat of the outbox, a negative id of a group included", function () {
        expect(outbox.validate(["-1001234567890"])).to.deep.equal({ chatId: -1_001_234_567_890 });
    });

    it("reads the user and the chat of an inbox group", function () {
        expect(inbox.validate(["5000000001", "-42"])).to.deep.equal({ userId: 5_000_000_001, chatId: -42 });
    });

    const refused: Array<[string, string[]]> = [
        ["no arguments", []],
        ["two ids for a chat", ["1", "2"]],
        ["an empty id", [""]],
        ["an id that is not a number", ["chat"]],
        ["an id with a fraction", ["1.5"]],
        ["an id with a sign after the digits", ["1-"]],
        ["an id with a letter before the digits", ["a1"]],
        ["an id beyond the safe integers", ["9007199254740993"]],
    ];

    for (const [name, args] of refused) {
        it(`refuses ${name} for the outbox with the form of its arguments`, function () {
            expectInvalid(() => outbox.validate(args), args, "<chatId>");
        });
    }

    it("refuses one id and three ids for an inbox group", function () {
        expectInvalid(() => inbox.validate(["1"]), ["1"], "<userId> <chatId>");
        expectInvalid(() => inbox.validate(["1", "2", "3"]), ["1", "2", "3"], "<userId> <chatId>");
    });

    it("refuses a second id that is not a number", function () {
        expectInvalid(() => inbox.validate(["1", "x"]), ["1", "x"], "<userId> <chatId>");
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
