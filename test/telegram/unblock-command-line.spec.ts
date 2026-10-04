import { expect } from "chai";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { InboxGroupKey } from "app/telegram/inbox/store/inbox-store.types";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import { UnblockCommandLine } from "app/telegram/unblock-command-line/unblock-command-line";
import { InvalidUnblockArguments, UNBLOCK_USAGE } from "app/telegram/unblock-command-line/unblock-command-line.errors";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";

const GROUP_CHAT = -1_001_234_567_890;
const USER = 5_000_000_001;
const FAILED_ID = 77;

type StoreCall = { method: string; argument: number | InboxGroupKey };

// Records what the command asks of the stores: what each call does to the rows is pinned by their specs.
class RecordingStores {
    public readonly calls: StoreCall[] = [];

    public async retryBlockedChat(chatId: number): Promise<number> {
        return this.record("retryBlockedChat", chatId);
    }

    public async skipBlockedChat(chatId: number): Promise<number> {
        return this.record("skipBlockedChat", chatId);
    }

    public async retryBlockedGroup(groupKey: InboxGroupKey): Promise<number> {
        return this.record("retryBlockedGroup", groupKey);
    }

    public async skipBlockedGroup(groupKey: InboxGroupKey): Promise<number> {
        return this.record("skipBlockedGroup", groupKey);
    }

    private record(method: string, argument: number | InboxGroupKey): number {
        this.calls.push({ method: method, argument: argument });

        return FAILED_ID;
    }
}

describe("UnblockCommandLine", function () {
    let stores: RecordingStores;
    let logger: RecordingLogger;
    let commandLine: UnblockCommandLine;

    beforeEach(function () {
        stores = new RecordingStores();
        logger = new RecordingLogger();
        commandLine = new UnblockCommandLine(stores as unknown as OutboxStore, stores as unknown as InboxStore, logger);
    });

    it("retries a blocked outbox chat and logs the message put back", async function () {
        await commandLine.run(["outbox", "retry", String(GROUP_CHAT)]);

        expect(stores.calls).to.deep.equal([{ method: "retryBlockedChat", argument: GROUP_CHAT }]);
        expect(logger.infos).to.deep.equal([
            {
                message: "Outbox chat is unblocked: its failed message is pending again.",
                payload: { chatId: GROUP_CHAT, messageId: FAILED_ID },
            },
        ]);
    });

    it("skips the failed message of a blocked outbox chat and logs it", async function () {
        await commandLine.run(["outbox", "skip", "42"]);

        expect(stores.calls).to.deep.equal([{ method: "skipBlockedChat", argument: 42 }]);
        expect(logger.infos).to.deep.equal([
            { message: "Outbox chat is unblocked: its failed message is skipped.", payload: { chatId: 42, messageId: FAILED_ID } },
        ]);
    });

    it("retries a blocked inbox group by its user and chat and logs the update put back", async function () {
        await commandLine.run(["inbox", "retry", String(USER), String(GROUP_CHAT)]);

        expect(stores.calls).to.deep.equal([{ method: "retryBlockedGroup", argument: { userId: USER, chatId: GROUP_CHAT } }]);
        expect(logger.infos).to.deep.equal([
            {
                message: "Inbox group is unblocked: its failed update is pending again.",
                payload: { userId: USER, chatId: GROUP_CHAT, updateId: FAILED_ID },
            },
        ]);
    });

    it("skips the failed update of a blocked inbox group and logs it", async function () {
        await commandLine.run(["inbox", "skip", String(USER), "42"]);

        expect(stores.calls).to.deep.equal([{ method: "skipBlockedGroup", argument: { userId: USER, chatId: 42 } }]);
        expect(logger.infos).to.deep.equal([
            {
                message: "Inbox group is unblocked: its failed update is skipped.",
                payload: { userId: USER, chatId: 42, updateId: FAILED_ID },
            },
        ]);
    });

    const refused: Array<[string, string[]]> = [
        ["no arguments", []],
        ["an unknown queue", ["queue", "retry", "1"]],
        ["an unknown action", ["outbox", "drop", "1"]],
        ["an outbox command without a chat", ["outbox", "retry"]],
        ["an outbox command with two ids", ["outbox", "skip", "1", "2"]],
        ["an inbox command with one id", ["inbox", "retry", "1"]],
        ["an inbox command with three ids", ["inbox", "skip", "1", "2", "3"]],
        ["an empty id", ["outbox", "retry", ""]],
        ["an id that is not a number", ["outbox", "retry", "chat"]],
        ["an id with a fraction", ["outbox", "retry", "1.5"]],
        ["an id with a sign after the digits", ["outbox", "retry", "1-"]],
        ["an id with a letter before the digits", ["outbox", "retry", "a1"]],
        ["an id beyond the safe integers", ["inbox", "skip", "1", "9007199254740993"]],
    ];

    for (const [name, args] of refused) {
        it(`refuses ${name} before it reads the database`, async function () {
            const error = await commandLine.run(args).then(
                () => expect.fail("run() was expected to reject"),
                (reason: unknown) => reason,
            );

            expect(error).to.be.instanceOf(InvalidUnblockArguments);
            expect((error as InvalidUnblockArguments).message).to.contain(UNBLOCK_USAGE);
            expect((error as InvalidUnblockArguments).payload).to.deep.equal({ args: args });
            expect(stores.calls).to.deep.equal([]);
            expect(logger.infos).to.deep.equal([]);
        });
    }

    it("lets the refusal of a store through and logs nothing", async function () {
        const failure = new Error("not blocked");
        stores.retryBlockedChat = (): Promise<number> => Promise.reject(failure);

        const error = await commandLine.run(["outbox", "retry", "1"]).then(
            () => expect.fail("run() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.equal(failure);
        expect(logger.infos).to.deep.equal([]);
    });
});
