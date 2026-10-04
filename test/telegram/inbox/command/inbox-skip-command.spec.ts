import { expect } from "chai";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import { IdArgumentsValidator } from "app/cli/validators/id-arguments-validator";
import { InboxSkipCommand } from "app/telegram/inbox/command/inbox-skip-command";
import { InvalidCommandArguments } from "app/cli/cli-command.errors";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";

const UPDATE_ID = 77;

describe("InboxSkipCommand", function () {
    let calls: unknown[];
    let logger: RecordingLogger;
    let command: InboxSkipCommand;
    let storeResult: Promise<number>;

    beforeEach(function () {
        calls = [];
        logger = new RecordingLogger();
        storeResult = Promise.resolve(UPDATE_ID);
        const store = {
            skipBlockedGroup: (...args: unknown[]): Promise<number> => {
                calls.push(args);

                return storeResult;
            },
        };

        command = new InboxSkipCommand(store as unknown as InboxStore, new IdArgumentsValidator(), logger);
    });

    it("runs the store with the ids it was given and logs what it took", async function () {
        await command.run(["5000000001", "-42"]);

        expect(calls).to.deep.equal([[{ userId: 5_000_000_001, chatId: -42 }]]);
        expect(logger.infos).to.deep.equal([
            {
                message: "Inbox group is unblocked: its failed update is skipped.",
                payload: { userId: 5_000_000_001, chatId: -42, updateId: UPDATE_ID },
            },
        ]);
    });

    it("refuses arguments that are not ids before it asks the store", async function () {
        const error = await command.run(["x"]).then(
            () => expect.fail("run() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.be.instanceOf(InvalidCommandArguments);
        expect(calls).to.deep.equal([]);
        expect(logger.infos).to.deep.equal([]);
    });

    it("lets the refusal of the store through and logs nothing", async function () {
        const failure = new Error("not blocked");
        storeResult = Promise.reject(failure);

        const error = await command.run(["5000000001", "-42"]).then(
            () => expect.fail("run() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.equal(failure);
        expect(logger.infos).to.deep.equal([]);
    });
});
