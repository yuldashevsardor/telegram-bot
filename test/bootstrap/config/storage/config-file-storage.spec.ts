import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConfigFileStorage } from "app/bootstrap/config/storage/file/config-file-storage";
import { ConfigFileUnreadable } from "app/bootstrap/config/storage/file/config-file-storage.errors";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { RawConfig } from "app/bootstrap/config/container/config-container.types";
import { change, replace } from "test/bootstrap/config/storage/config-file-storage.helper";

// The polling interval in the spec is tens of milliseconds: the real one (2000) would stretch the
// run into minutes, while single digits would make the "there was no signal" checks meaningless:
// their windows are set by the interval (`sleep(INTERVAL * 4)` and `sleep(INTERVAL * 6)`) and would
// come down to a few milliseconds. No margin is left for a poll to land in such a window, and a
// check that passed would no longer mean that a poll was in it.
const INTERVAL = 25;

function base(raw: RawConfig): ConfigStorage {
    return { load: async (): Promise<RawConfig> => raw };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits for a number of signals rather than a predicate over it: the counter of signals only grows,
// so an overshoot makes strict equality false forever, and the wait ends on the same deadline as a
// shortfall. A message about a signal that never happened would then blame the watcher for a loss,
// although there were more signals than expected, and the search would go the wrong way. Hence the
// comparison of numbers: both the text and the actual and the expected printed next to it are true
// in either direction. The text says nothing about time: an overshoot does not wait for the deadline
// — the counter will not win it back, and the diagnosis is ready at once.
async function waitForSignals(signals: () => number, expected: number, timeout = 1000): Promise<void> {
    const deadline = Date.now() + timeout;
    let actual = signals();

    while (actual !== expected) {
        if (actual > expected || Date.now() > deadline) {
            expect(actual).to.equal(expected, "the storage did not signal the expected number of changes");
        }

        await sleep(1);
        actual = signals();
    }
}

describe("ConfigFileStorage", () => {
    let directory: string;
    let filePath: string;
    let storages: ConfigFileStorage[];

    beforeEach(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "config-file-storage-"));
        filePath = path.join(directory, "runtime.env");
        storages = [];
    });

    // A poll left behind would hold the event loop: mocha has no --exit, and the run would sit out
    // its own timeout instead of finishing.
    afterEach(async () => {
        for (const storage of storages) {
            storage.unwatch();
        }

        await fs.rm(directory, { recursive: true, force: true });
    });

    function storage(interval = INTERVAL, raw: RawConfig = {}): ConfigFileStorage {
        const created = new ConfigFileStorage(base(raw), filePath, interval);

        storages.push(created);

        return created;
    }

    // The file lies under the base source: what is set there overrides it, while the file itself
    // adds values for the keys the base source does not hold.
    it("lets the base source win over the file", async () => {
        await fs.writeFile(filePath, "FROM_FILE=file\nSHARED=file\n");

        const raw = await storage(INTERVAL, { FROM_BASE: "base", SHARED: "base" }).load();

        expect(raw["FROM_BASE"]).to.equal("base");
        expect(raw["FROM_FILE"]).to.equal("file");
        expect(raw["SHARED"]).to.equal("base");
    });

    // A blank variable of the base source is "not set", not "set to blank": half of the variables in
    // .env are declared blank, and were they to override the file, changing them on the fly would be
    // impossible. dotenv keeps quoted spaces (unquoted ones it trims itself), and ConfigParser treats
    // them as blank anyway.
    it("lets the file value through for a key the base source leaves blank", async () => {
        await fs.writeFile(filePath, "BLANK=file\nPADDED=file\nMISSING=file\n");

        // The base source is free to return undefined: the snapshot is declared as Record<string,
        // string | undefined>, and it must not be treated as a string.
        const raw = await storage(INTERVAL, { BLANK: "", PADDED: "   ", MISSING: undefined }).load();

        expect(raw["BLANK"]).to.equal("file");
        expect(raw["PADDED"]).to.equal("file");
        expect(raw["MISSING"]).to.equal("file");
    });

    // A missing file is a normal state: watching starts before it appears, and deleting it returns
    // the values to the base source.
    it("falls back to the base source when there is no file", async () => {
        const raw = await storage(INTERVAL, { FROM_BASE: "base" }).load();

        expect(raw).to.deep.equal({ FROM_BASE: "base" });
    });

    // An empty set instead of a failure would drop every value of the file at once, and the reason
    // would stay unknown.
    it("throws ConfigFileUnreadable when the path cannot be read", async () => {
        // A directory in place of the file: reading it fails with EISDIR, not with ENOENT.
        await fs.mkdir(filePath);

        const failed = await storage()
            .load()
            .then(
                () => expect.fail("load() was expected to reject"),
                (reason: unknown) => reason,
            );

        expect(failed).to.be.instanceOf(ConfigFileUnreadable);
        expect(failed).to.have.property("message", `Config file "${filePath}" is unreadable`);
        expect(failed).to.have.property("payload").that.deep.equals({ path: filePath });
        expect(failed).to.have.property("cause").that.has.property("code", "EISDIR");
    });

    it("reports the appearance, the change and the removal of the file", async () => {
        const watchable = storage();
        let signals = 0;

        watchable.watch(() => {
            signals += 1;
        });

        // On a missing file the listener is called right after the subscription, with zeroes in both
        // snapshots: that call does not count as a change.
        await sleep(INTERVAL * 4);
        expect(signals).to.equal(0);

        await replace(filePath, "A=1\n");
        await waitForSignals(() => signals, 1);

        // The same length: the change is visible by the modification time, not by the size. The size
        // is checked after the write, because the safeguard in change() is "not shorter": a literal
        // lengthened during a later edit would pass it silently, slipping over to a check by size and
        // leaving this line a lie.
        await change(filePath, "A=2\n");
        expect((await fs.stat(filePath)).size).to.equal(Buffer.byteLength("A=1\n"));
        await waitForSignals(() => signals, 2);

        expect((await watchable.load())["A"]).to.equal("2");

        await fs.rm(filePath);
        await waitForSignals(() => signals, 3);

        expect(await watchable.load()).to.deep.equal({});
    });

    // An editor saves a file by writing a temporary one and renaming it over: the inode changes, and
    // a subscription to file system events would lose the file along with it.
    it("keeps reporting after the file has been replaced with another inode", async () => {
        await fs.writeFile(filePath, "A=1\n");

        const watchable = storage();
        let signals = 0;

        watchable.watch(() => {
            signals += 1;
        });

        // The watcher takes the baseline state only after the subscription: an edit that outran the
        // first poll would land in that state and would not count as a change.
        await sleep(INTERVAL * 4);

        await replace(filePath, "A=2\n");
        await waitForSignals(() => signals, 1);

        await change(filePath, "A=3\n");
        await waitForSignals(() => signals, 2);

        expect((await watchable.load())["A"]).to.equal("3");
    });

    // An edit that kept the modification time (an archiver, rsync --times) is visible by the size:
    // otherwise such a file would stay unread until the next ordinary edit. The time is set
    // explicitly for both states of the file: a natural modification time comes with nanoseconds,
    // while one put back through Date is rounded to milliseconds, and the comparison of times would
    // tell them apart on its own. The interval is a second on purpose: the write and the restoring of
    // the time have to land in one poll, otherwise a poll between them would see the new time and the
    // check would be about something else.
    it("reports a change that kept the modification time", async function () {
        this.timeout(6000);

        const time = new Date(1700000000000);

        await fs.writeFile(filePath, "A=1\n");
        await fs.utimes(filePath, time, time);

        const watchable = storage(1000);
        let signals = 0;

        watchable.watch(() => {
            signals += 1;
        });

        await change(filePath, "A=1234567890\n");
        await fs.utimes(filePath, time, time);
        await waitForSignals(() => signals, 1, 4000);

        expect((await watchable.load())["A"]).to.equal("1234567890");
    });

    // Watching that was removed is started again: otherwise there would be nothing to switch it off
    // for a while and bring it back with.
    it("watches again after unwatch()", async () => {
        await fs.writeFile(filePath, "A=1\n");

        const watchable = storage();
        let signals = 0;

        watchable.unwatch();
        watchable.watch(() => {
            signals += 1;
        });

        await sleep(INTERVAL * 4);
        await change(filePath, "A=2\n");
        await waitForSignals(() => signals, 1);

        watchable.unwatch();
        watchable.watch(() => {
            signals += 1;
        });

        await sleep(INTERVAL * 4);
        await change(filePath, "A=3\n");
        await waitForSignals(() => signals, 2);
    });

    it("stops reporting after unwatch()", async () => {
        await fs.writeFile(filePath, "A=1\n");

        const watchable = storage();
        let signals = 0;

        watchable.watch(() => {
            signals += 1;
        });

        await sleep(INTERVAL * 4);
        watchable.unwatch();

        await change(filePath, "A=2\n");
        await sleep(INTERVAL * 6);

        expect(signals).to.equal(0);
    });

    // A second watch() on top of the first would start a second poll of the same path, while
    // unwatch() would remove both at once: the listener would silently stop receiving signals.
    it("keeps a single watch when watch() is called twice", async () => {
        await fs.writeFile(filePath, "A=1\n");

        const watchable = storage();
        let signals = 0;

        watchable.watch(() => {
            signals += 1;
        });
        watchable.watch(() => {
            signals += 1;
        });

        await sleep(INTERVAL * 4);
        await change(filePath, "A=2\n");
        await waitForSignals(() => signals, 1);
        await sleep(INTERVAL * 4);

        expect(signals).to.equal(1);
    });

    // An unwatch() without a watch() is the ordinary shutdown path of an application that never got
    // as far as watching. The source has no listener of its own then, and it is not entitled to
    // remove other people's from the path: unwatchFile without a listener removes everyone watching
    // it.
    it("does nothing on unwatch() without watch()", async () => {
        await fs.writeFile(filePath, "A=1\n");

        const watching = storage();
        const idle = storage();
        let signals = 0;

        watching.watch(() => {
            signals += 1;
        });

        await sleep(INTERVAL * 4);

        expect(() => idle.unwatch()).to.not.throw();

        await change(filePath, "A=2\n");
        await waitForSignals(() => signals, 1);
    });
});
