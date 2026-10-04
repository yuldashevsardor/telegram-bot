import { expect } from "chai";
import type { CliCommand } from "app/cli/cli-command";
import { UnknownCommand } from "app/cli/cli-command.errors";
import { InboxCommandResolver } from "app/telegram/inbox/command/inbox-command-resolver";

const RETRY: CliCommand = { run: async (): Promise<void> => undefined };
const SKIP: CliCommand = { run: async (): Promise<void> => undefined };

describe("InboxCommandResolver", function () {
    const resolver = new InboxCommandResolver(RETRY, SKIP);

    it("gives the retry command for retry and the skip command for skip", function () {
        expect(resolver.resolve("retry", ["inbox", "retry"])).to.equal(RETRY);
        expect(resolver.resolve("skip", ["inbox", "skip"])).to.equal(SKIP);
    });

    for (const action of [undefined, "drop", "Retry"]) {
        it(`refuses the action ${String(action)}`, function () {
            const args = ["inbox", ...(action === undefined ? [] : [action])];
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
