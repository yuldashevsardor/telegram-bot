import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConfigFileStorage } from "app/bootstrap/config/storage/file/config-file-storage";
import { ConfigFileUnreadable } from "app/bootstrap/config/storage/file/config-file-storage.errors";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { RawConfig } from "app/bootstrap/config/container/config-container.types";
import { change, replace } from "test/bootstrap/config/storage/config-file-storage.helper";

// The polling interval in the spec is tens of milliseconds. The real one (2000) would stretch the
// run into minutes. Single digits would make the "there was no signal" checks meaningless: their
// windows are set by the interval (`sleep(INTERVAL * 4)` and `sleep(INTERVAL * 6)`) and would come
// down to a few milliseconds. Such a window leaves no margin for a poll to land in it, and a check
// that passed would no longer mean that a poll was in it.
const INTERVAL = 25;

function base(raw: RawConfig): ConfigStorage {
    return { load: async (): Promise<RawConfig> => raw };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits for a number of signals and compares numbers rather than checking a predicate over them.
// The counter of signals only grows, so after an overshoot strict equality stays false forever. A
// predicate would then wait out the same deadline as on a shortfall. Its message about a signal
// that never happened would blame the watcher for a loss, although there were more signals than
// expected, and the search would go the wrong way. The comparison of numbers keeps both the text
// and the actual and expected values printed next to it true in either direction. The text says
// nothing about time, because an overshoot does not wait for the deadline. The counter will not
// win it back, so the diagnosis is ready at once.
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

    // A blank variable of the base source is "not set", not "set to blank". Half of the variables in
    // .env are declared blank, and were they to override the file, they could not be changed on the
    // fly. Spaces count as blank too. dotenv keeps quoted spaces (unquoted ones it trims itself), and
    // ConfigParser treats them as blank anyway.
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

        // The same length, so the change is visible by the modification time, not by the size. The
        // size is checked after the write, because the safeguard in change() is only "not shorter". A
        // literal lengthened during a later edit would pass it silently. The spec would slip over to
        // a check by size, and this comment would become a lie.
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

    // An edit that kept the modification time (an archiver, rsync --times) is visible by the size.
    // Otherwise such a file would stay unread until the next ordinary edit.
    //
    // The time is set explicitly for both states of the file. A natural modification time comes with
    // nanoseconds, while one put back through Date is rounded to milliseconds, so the comparison of
    // times would tell them apart on its own.
    //
    // The interval is a second on purpose: the write and the restoring of the time have to land in
    // one poll. A poll between them would see the new time, and the check would be about something
    // else.
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

    // Watching that was removed can be started again. Otherwise it could not be switched off for a
    // while and brought back.
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

    // A second watch() on top of the first would add a second listener to the poll of the same path,
    // and every change would give two signals. unwatch() would then remove only the second listener:
    // the first one would go on polling and signalling after the stop.
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
    // as far as watching. The source has no listener of its own then. It is not entitled to remove
    // other people's from the path, and unwatchFile without a listener removes everyone watching it.
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
