import { expect } from "chai";
import type { CliCommand } from "app/cli/cli-command";
import { CliCommandResolver } from "app/cli/cli-command-resolver";
import { UnknownCommand } from "app/cli/cli-command.errors";
import { TelegramQueueCommandResolver } from "app/cli/telegram/queue-command-resolver";

const OUTBOX_COMMAND: CliCommand = { run: async () => undefined };
const INBOX_COMMAND: CliCommand = { run: async () => undefined };

type ResolveCall = { action: string | undefined; args: readonly string[] };

class RecordingResolver extends TelegramQueueCommandResolver {
    public readonly calls: ResolveCall[] = [];

    public constructor(private readonly command: CliCommand) {
        super(command, command);
    }

    public override resolve(action: string | undefined, args: readonly string[]): CliCommand {
        this.calls.push({ action, args });

        return this.command;
    }
}

describe("CliCommandResolver", function () {
    let outbox: RecordingResolver;
    let inbox: RecordingResolver;
    let resolver: CliCommandResolver;

    beforeEach(function () {
        outbox = new RecordingResolver(OUTBOX_COMMAND);
        inbox = new RecordingResolver(INBOX_COMMAND);
        resolver = new CliCommandResolver(outbox, inbox);
    });

    it("gives an outbox command to the resolver of the outbox, with the arguments left for the command", function () {
        const args = ["outbox", "retry", "-42"];

        expect(resolver.resolve(args)).to.deep.equal({ command: OUTBOX_COMMAND, commandArgs: ["-42"] });
        expect(outbox.calls).to.deep.equal([{ action: "retry", args }]);
        expect(inbox.calls).to.deep.equal([]);
    });

    it("gives an inbox command to the resolver of the inbox", function () {
        const args = ["inbox", "skip", "1", "2"];

        expect(resolver.resolve(args)).to.deep.equal({ command: INBOX_COMMAND, commandArgs: ["1", "2"] });
        expect(inbox.calls).to.deep.equal([{ action: "skip", args }]);
        expect(outbox.calls).to.deep.equal([]);
    });

    for (const args of [[], ["queue", "retry", "1"], ["Outbox", "retry"]]) {
        it(`refuses the queue of "${args.join(" ")}" and asks no resolver`, function () {
            const error = catchError(() => resolver.resolve(args));

            expect(error).to.be.instanceOf(UnknownCommand);
            expect((error as UnknownCommand).payload).to.deep.equal({ args });
            expect(outbox.calls.concat(inbox.calls)).to.deep.equal([]);
        });
    }
});

function catchError(call: () => unknown): unknown {
    try {
        call();
    } catch (error) {
        return error;
    }

    return undefined;
}
