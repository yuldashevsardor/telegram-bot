import { expect } from "chai";
import type { CliCommand } from "app/telegram/cli-command/cli-command";
import { UnknownCommand } from "app/telegram/cli-command/cli-command.errors";
import { OutboxCommandResolver } from "app/telegram/outbox/command/outbox-command-resolver";

const RETRY: CliCommand = { run: async (): Promise<void> => undefined };
const SKIP: CliCommand = { run: async (): Promise<void> => undefined };

describe("OutboxCommandResolver", function () {
    const resolver = new OutboxCommandResolver(RETRY, SKIP);

    it("gives the retry command for retry and the skip command for skip", function () {
        expect(resolver.resolve("retry", ["outbox", "retry"])).to.equal(RETRY);
        expect(resolver.resolve("skip", ["outbox", "skip"])).to.equal(SKIP);
    });

    for (const action of [undefined, "drop", "Retry"]) {
        it(`refuses the action ${String(action)}`, function () {
            const args = ["outbox", ...(action === undefined ? [] : [action])];
            let error: unknown;

            try {
                resolver.resolve(action, args);
            } catch (reason) {
                error = reason;
            }

            expect(error).to.be.instanceOf(UnknownCommand);
            expect((error as UnknownCommand).payload).to.deep.equal({ args });
        });
    }
});
