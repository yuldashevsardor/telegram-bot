import { expect } from "chai";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import { IdArgumentsValidator } from "app/cli/validators/id-arguments-validator";
import { OutboxSkipCommand } from "app/telegram/outbox/command/outbox-skip-command";
import { InvalidCommandArguments } from "app/cli/cli-command.errors";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";

const MESSAGE_ID = 77;

describe("OutboxSkipCommand", function () {
    let calls: unknown[];
    let logger: RecordingLogger;
    let command: OutboxSkipCommand;
    let storeResult: Promise<number>;

    beforeEach(function () {
        calls = [];
        logger = new RecordingLogger();
        storeResult = Promise.resolve(MESSAGE_ID);
        const store = {
            skipBlockedChat: (...args: unknown[]): Promise<number> => {
                calls.push(args);

                return storeResult;
            },
        };

        command = new OutboxSkipCommand(store as unknown as OutboxStore, new IdArgumentsValidator(), logger);
    });

    it("runs the store with the ids it was given and logs what it took", async function () {
        await command.run(["42"]);

        expect(calls).to.deep.equal([[42]]);
        expect(logger.infos).to.deep.equal([
            {
                message: "Outbox chat is unblocked: its failed message is skipped.",
                payload: { chatId: 42, messageId: MESSAGE_ID },
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

        const error = await command.run(["42"]).then(
            () => expect.fail("run() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.equal(failure);
        expect(logger.infos).to.deep.equal([]);
    });
});
