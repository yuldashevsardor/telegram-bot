import { expect } from "chai";
import { ConfigContainer } from "app/bootstrap/config/container/config-container";
import { ConfigContainerIsNotInitialized } from "app/bootstrap/config/container/config-container.errors";
import type { ConfigBuilder } from "app/bootstrap/config/builder/config-builder";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { WatchableConfigStorage } from "app/bootstrap/config/storage/watchable-config-storage";
import type { RawConfig } from "app/bootstrap/config/container/config-container.types";
import { InvalidConfigError } from "app/shared/errors";

type Values = {
    tempDir: string;
    limits: {
        common: { number: number; interval: number };
    };
};

function storage(raw: RawConfig): ConfigStorage {
    return { load: async (): Promise<RawConfig> => raw };
}

// The builder returns what it was given, without parsing. The shape of the values here drifts from
// the declared one on purpose: get() catches that drift, and the compiler does not see it.
function returning(values: object): ConfigBuilder<Values> {
    return { build: (): Values => values as Values };
}

async function container(values: object): Promise<ConfigContainer<Values>> {
    const cc = new ConfigContainer<Values>(storage({}), returning(values));
    await cc.init();

    return cc;
}

// A watchable source with a replaceable snapshot. The spec gives the signal by hand, so a rebuild
// depends neither on the file system nor on a polling interval.
class FakeWatchableStorage implements WatchableConfigStorage {
    public raw: RawConfig = {};
    public loads = 0;
    public watchCalls = 0;
    public unwatchCalls = 0;

    private onChanged: (() => void) | null = null;
    private captured: (() => void) | null = null;
    private held: Promise<void> | null = null;

    public async load(): Promise<RawConfig> {
        this.loads += 1;

        if (this.held !== null) {
            await this.held;
        }

        return this.raw;
    }

    public watch(onChanged: () => void): void {
        this.watchCalls += 1;
        this.onChanged = onChanged;
        this.captured = onChanged;
    }

    public unwatch(): void {
        this.unwatchCalls += 1;
        this.onChanged = null;
    }

    public signal(): void {
        if (this.onChanged === null) {
            expect.fail("the storage was signalled while nobody was watching it");
        }

        this.onChanged();
    }

    // A signal that bypasses the stop. A real source will not send one, but the callback of the
    // watcher could have been queued before unwatch(). The container guards against that itself.
    public signalIgnoringStop(): void {
        if (this.captured === null) {
            expect.fail("the storage was signalled while nobody has ever watched it");
        }

        this.captured();
    }

    // Holds load() until the returned function is called, so a spec can give signals in the middle
    // of a running rebuild.
    public holdLoads(): () => void {
        let release = (): void => undefined;

        this.held = new Promise<void>((resolve) => {
            release = (): void => resolve();
        });

        return (): void => {
            this.held = null;
            release();
        };
    }
}

// Assembles the values from the snapshot, like the real builder: a rebuild has to see the snapshot
// change.
const fromRaw: ConfigBuilder<Values> = {
    build: (raw): Values => ({
        tempDir: raw["TEMP_DIR"] ?? "/tmp",
        limits: {
            common: {
                number: Number(raw["NUMBER"] ?? "1"),
                interval: Number(raw["INTERVAL"] ?? "1000"),
            },
        },
    }),
};

type Watched = {
    cc: ConfigContainer<Values>;
    storage: FakeWatchableStorage;
};

async function watched(raw: RawConfig = {}, builder: ConfigBuilder<Values> = fromRaw): Promise<Watched> {
    const storage = new FakeWatchableStorage();
    storage.raw = raw;

    const cc = new ConfigContainer<Values>(storage, builder);
    await cc.init();

    return { cc: cc, storage: storage };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const waitLimit = 1000;

// A spec waits for a rebuild on a signal by letting the task queue turn over. It cannot await a
// promise: the callback of the watcher returns nothing. By the time the timer fires, a rebuild on
// the fake source is finished, delivery and all, because its load() never leaves the process.
async function signalled(storage: FakeWatchableStorage): Promise<void> {
    storage.signal();

    await sleep(0);
}

// Waits for a number of events rather than a predicate over it. On a counter that only grows,
// strict equality stays false after an overshoot too. A predicate would sit out the deadline and
// call a surplus rebuild a lost one. The shape is explained at waitForSignals in
// test/bootstrap/config/storage/config-file-storage.spec.ts.
async function waitForCount(counter: () => number, expected: number, subject: string): Promise<void> {
    const deadline = Date.now() + waitLimit;
    let actual = counter();

    while (actual !== expected) {
        if (actual > expected || Date.now() > deadline) {
            expect(actual).to.equal(expected, `unexpected number of ${subject}`);
        }

        await sleep(1);
        actual = counter();
    }
}

async function waitFor(done: () => boolean): Promise<void> {
    const deadline = Date.now() + waitLimit;

    while (!done()) {
        if (Date.now() > deadline) {
            expect.fail(`the condition is not met within ${waitLimit} ms`);
        }

        await sleep(1);
    }
}

describe("ConfigContainer", () => {
    it("builds the values from what the storage has loaded", async () => {
        const builder: ConfigBuilder<Values> = {
            build: (raw): Values => ({ tempDir: raw["TEMP_DIR"] ?? "", limits: { common: { number: 1, interval: 1 } } }),
        };
        const cc = new ConfigContainer<Values>(storage({ TEMP_DIR: "/data/tmp" }), builder);

        await cc.init();

        expect(cc.get("tempDir")).to.equal("/data/tmp");
    });

    it("throws ConfigContainerIsNotInitialized before init()", () => {
        const cc = new ConfigContainer<Values>(storage({}), returning({ tempDir: "/tmp" }));

        expect(() => cc.get("tempDir"))
            .to.throw(ConfigContainerIsNotInitialized)
            .with.property("message", "ConfigContainer is not initialized, call init() first.");
    });

    it("resolves a dotted path", async () => {
        const common = { number: 30, interval: 1000 };
        const cc = await container({ tempDir: "/tmp", limits: { common: common } });

        expect(cc.get("limits.common")).to.equal(common);
        expect(cc.get("limits.common.interval")).to.equal(1000);
        expect(cc.get("tempDir")).to.equal("/tmp");
    });

    it("throws InvalidConfigError when the value is undefined", async () => {
        const cc = await container({});

        expect(() => cc.get("tempDir"))
            .to.throw(InvalidConfigError, 'Invalid config "tempDir"')
            .with.property("payload")
            .that.deep.equals({ path: "tempDir" });
    });

    it("throws InvalidConfigError when an object on the path is missing", async () => {
        const cc = await container({});

        expect(() => cc.get("limits.common"))
            .to.throw(InvalidConfigError)
            .with.property("payload")
            .that.deep.equals({ path: "limits.common" });
    });

    // typeof null is "object" too: without a separate check for null the walk would fail with a
    // TypeError.
    it("throws InvalidConfigError when an object on the path is null", async () => {
        const cc = await container({ limits: null });

        expect(() => cc.get("limits.common"))
            .to.throw(InvalidConfigError)
            .with.property("payload")
            .that.deep.equals({ path: "limits.common" });
    });

    describe("init()", () => {
        // init() starts watching itself. A separate call could be forgotten, and the configuration
        // would silently stay on the values of the startup.
        it("starts watching a storage that reports changes", async () => {
            const { storage } = await watched();

            expect(storage.watchCalls).to.equal(1);
        });

        // A source with nothing to watch, like process.env, is not a failure. A container with such a
        // source stays on the values of the startup.
        it("accepts a storage that cannot report changes", async () => {
            const cc = await container({ tempDir: "/tmp" });

            expect(cc.get("tempDir")).to.equal("/tmp");
        });

        // Watching is a pair of methods, and the container watches only a source that has both. It
        // could start watching a source with watch() alone but could not remove the watching, and
        // the poll would outlive the shutdown of the application.
        it("does not watch a storage that has only half of the watching methods", async () => {
            let watches = 0;
            const halfWatchable = {
                load: async (): Promise<RawConfig> => ({}),
                watch: (): void => {
                    watches += 1;
                },
            };
            const cc = new ConfigContainer<Values>(halfWatchable, returning({ tempDir: "/tmp" }));

            await cc.init();
            cc.unwatch();

            expect(watches).to.equal(0);
        });

        // The other half of the pair. Were a source with only unwatch() taken for watchable, the
        // container would call the watch() it does not have, and init() would fail with a TypeError.
        it("accepts a storage that has only the other half of the watching methods", async () => {
            const halfWatchable = {
                load: async (): Promise<RawConfig> => ({}),
                unwatch: (): void => undefined,
            };
            const cc = new ConfigContainer<Values>(halfWatchable, returning({ tempDir: "/tmp" }));

            await cc.init();

            expect(cc.get("tempDir")).to.equal("/tmp");
        });
    });

    describe("unwatch()", () => {
        // A rebuild started before the stop no longer changes the values. Right after unwatch() they
        // are read by whoever shuts the application down: `Application.terminate()` takes the
        // shutdown deadline from there.
        it("cancels the rebuild that is already reading the source", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            let calls = 0;

            cc.onChange("tempDir", () => {
                calls += 1;
            });

            const release = storage.holdLoads();

            storage.raw = { TEMP_DIR: "/data/next" };
            storage.signal();

            cc.unwatch();
            release();
            await sleep(0);

            expect(cc.get("tempDir")).to.equal("/data");
            expect(calls).to.equal(0);
        });

        // A pass that ran into an unwatch() does not return the container to watching. Otherwise a
        // late signal would start a rebuild for an application that is already closed: the callback
        // of the watcher could have been queued before the stop.
        it("leaves the container unwatching when it happens in the middle of a rebuild", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const release = storage.holdLoads();

            storage.signal();
            cc.unwatch();
            release();
            await sleep(0);

            const loadsAfterRebuild = storage.loads;

            storage.signalIgnoringStop();
            await sleep(0);

            expect(storage.loads).to.equal(loadsAfterRebuild);
        });

        // A signal that arrived while a rebuild was running leaves a mark asking for one more pass.
        // After the stop that mark concerns nobody: the second pass would read the snapshot for an
        // application that is shutting down.
        it("cancels the extra pass that a signal during the rebuild has asked for", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const release = storage.holdLoads();

            storage.signal();
            storage.signal();

            const loadsBeforeUnwatch = storage.loads;

            cc.unwatch();
            release();
            await sleep(0);

            expect(storage.loads).to.equal(loadsBeforeUnwatch);
        });

        it("ignores a signal that arrives after it", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const loadsAfterInit = storage.loads;

            cc.unwatch();

            storage.raw = { TEMP_DIR: "/data/next" };
            storage.signalIgnoringStop();
            await sleep(0);

            expect(storage.loads).to.equal(loadsAfterInit);
            expect(cc.get("tempDir")).to.equal("/data");
        });

        it("unwatches the storage", async () => {
            const { cc, storage } = await watched();

            cc.unwatch();

            expect(storage.unwatchCalls).to.equal(1);
        });

        // A source with nothing to watch, like process.env, has nothing to unwatch either. The
        // shutdown of the application calls unwatch() without looking at whether the source is
        // watchable.
        it("does nothing with a storage that cannot report changes", async () => {
            const cc = await container({ tempDir: "/tmp" });

            expect(() => cc.unwatch()).to.not.throw();
        });
    });

    describe("rebuild on a signal from the storage", () => {
        it("calls the listener of a changed leaf with the new and the old value", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const calls: Array<[string, string]> = [];

            cc.onChange("tempDir", (newValue, oldValue) => {
                calls.push([newValue, oldValue]);
            });

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);

            expect(calls).to.deep.equal([["/data/next", "/data"]]);
            expect(cc.get("tempDir")).to.equal("/data/next");
        });

        // A subscription to a subtree covers every value inside it. What matters to a listener of
        // the limits is that something inside changed, not which leaf it was.
        it("calls the listener of a subtree when a value inside it changes", async () => {
            const { cc, storage } = await watched({ NUMBER: "1" });
            const calls: Array<[unknown, unknown]> = [];

            cc.onChange("limits", (newValue, oldValue) => {
                calls.push([newValue, oldValue]);
            });

            storage.raw = { NUMBER: "2" };
            await signalled(storage);

            expect(calls).to.deep.equal([[{ common: { number: 2, interval: 1000 } }, { common: { number: 1, interval: 1000 } }]]);
        });

        // One call per rebuild, not one for every changed leaf inside. The paths are collected into
        // a set, so the path of a subtree occurs in it once.
        it("calls the listener of a subtree once when two values inside it change", async () => {
            const { cc, storage } = await watched({ NUMBER: "1", INTERVAL: "1000" });
            let calls = 0;

            cc.onChange("limits", () => {
                calls += 1;
            });

            storage.raw = { NUMBER: "2", INTERVAL: "2000" };
            await signalled(storage);

            expect(calls).to.equal(1);
            expect(cc.get("limits.common")).to.deep.equal({ number: 2, interval: 2000 });
        });

        // The builder creates new objects on every assembly, so comparing subtrees by reference
        // would report a change on every rebuild.
        it("keeps silent when the rebuilt values repeat the previous ones", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            let calls = 0;

            cc.onChange("limits", () => {
                calls += 1;
            });
            cc.onChange("tempDir", () => {
                calls += 1;
            });

            await signalled(storage);

            expect(calls).to.equal(0);
        });

        it("keeps silent for the paths nobody subscribed to", async () => {
            const { cc, storage } = await watched({ NUMBER: "1" });
            let calls = 0;

            cc.onChange("tempDir", () => {
                calls += 1;
            });

            storage.raw = { NUMBER: "2" };
            await signalled(storage);

            expect(calls).to.equal(0);
            expect(cc.get("limits.common.number")).to.equal(2);
        });

        // Unsubscribing the last listener of a path does not close the path: a subscription to it has
        // to work like the first one.
        it("accepts a new listener on a path whose last listener has unsubscribed", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const calls: string[] = [];

            cc.onChange("tempDir", () => {
                calls.push("first");
            })();

            cc.onChange("tempDir", () => {
                calls.push("second");
            });

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);

            expect(calls).to.deep.equal(["second"]);
        });

        it("stops calling a listener that has unsubscribed and keeps the rest of the path", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const calls: string[] = [];

            const unsubscribe = cc.onChange("tempDir", () => {
                calls.push("first");
            });
            cc.onChange("tempDir", () => {
                calls.push("second");
            });

            unsubscribe();

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);

            expect(calls).to.deep.equal(["second"]);
        });

        // An optional subtree that became null is a change of the path itself, not of its leaves:
        // there is nothing to walk in a null. The listener is given whatever now lies at its path.
        it("reports a subtree that became null as a change of its own path", async () => {
            const values: Values[] = [
                { tempDir: "/data", limits: { common: { number: 1, interval: 1000 } } },
                { tempDir: "/data", limits: null as unknown as Values["limits"] },
            ];
            const sequence: ConfigBuilder<Values> = {
                build: (): Values => values.shift() ?? { tempDir: "/data", limits: null as unknown as Values["limits"] },
            };
            const { cc, storage } = await watched({}, sequence);
            const calls: Array<[unknown, unknown]> = [];
            let insideCalls = 0;

            cc.onChange("limits", (newValue, oldValue) => {
                calls.push([newValue, oldValue]);
            });
            cc.onChange("limits.common.number", () => {
                insideCalls += 1;
            });

            await signalled(storage);

            expect(calls).to.deep.equal([[null, { common: { number: 1, interval: 1000 } }]]);
            expect(insideCalls).to.equal(0);
        });

        it("keeps the previous values and reports the failure when the build fails", async () => {
            const failing: ConfigBuilder<Values> = {
                build: (raw): Values => {
                    if (raw["TEMP_DIR"] === "/broken") {
                        throw new InvalidConfigError('Invalid config "tempDir"');
                    }

                    return fromRaw.build(raw);
                },
            };
            const { cc, storage } = await watched({ TEMP_DIR: "/data" }, failing);
            const errors: unknown[] = [];

            cc.onError((error) => {
                errors.push(error);
            });

            storage.raw = { TEMP_DIR: "/broken" };
            await signalled(storage);

            expect(errors).to.have.lengthOf(1);
            expect(errors[0]).to.be.instanceOf(InvalidConfigError);
            expect(cc.get("tempDir")).to.equal("/data");
        });

        it("stops reporting to an error listener that has unsubscribed", async () => {
            const failing: ConfigBuilder<Values> = {
                build: (raw): Values => {
                    if (raw["TEMP_DIR"] === "/broken") {
                        throw new InvalidConfigError("the config is broken");
                    }

                    return fromRaw.build(raw);
                },
            };
            const { cc, storage } = await watched({ TEMP_DIR: "/data" }, failing);
            const errors: unknown[] = [];

            const unsubscribe = cc.onError((error) => {
                errors.push(error);
            });

            unsubscribe();

            storage.raw = { TEMP_DIR: "/broken" };
            await signalled(storage);

            expect(errors).to.have.lengthOf(0);
            expect(cc.get("tempDir")).to.equal("/data");
        });

        // The values are replaced before the delivery: a listener that asks the configuration by
        // another path has to see the new one already.
        it("gives a listener the values that are already new", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data", NUMBER: "1" });
            const seen: number[] = [];

            cc.onChange("tempDir", () => {
                seen.push(cc.get("limits.common.number"));
            });

            storage.raw = { TEMP_DIR: "/data/next", NUMBER: "2" };
            await signalled(storage);

            expect(seen).to.deep.equal([2]);
        });

        it("reads the source once per signal", async () => {
            const { storage } = await watched();
            const loadsAfterInit = storage.loads;

            await signalled(storage);

            expect(storage.loads - loadsAfterInit).to.equal(1);
        });

        // Rebuilds do not run in parallel: they would race for one field of values, and a race would
        // decide the order of events. The signals that arrive during a rebuild merge into one pass.
        // One is enough: the snapshot is read whole and will see the latest state of the source.
        it("merges the signals that arrive during a rebuild into one extra pass", async () => {
            const { storage } = await watched();
            const loadsAfterInit = storage.loads;
            const release = storage.holdLoads();

            storage.signal();
            storage.signal();
            storage.signal();

            release();
            await waitForCount(() => storage.loads - loadsAfterInit, 2, "reads from the storage");
            await sleep(0);

            expect(storage.loads - loadsAfterInit).to.equal(2);
        });
    });

    describe("listeners", () => {
        it("reports a listener that threw and still calls the rest", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const failure = new Error("listener is broken");
            const errors: unknown[] = [];
            let calls = 0;

            cc.onError((error) => {
                errors.push(error);
            });
            cc.onChange("tempDir", () => {
                throw failure;
            });
            cc.onChange("tempDir", () => {
                calls += 1;
            });

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);

            expect(errors).to.deep.equal([failure]);
            expect(calls).to.equal(1);
        });

        // A listener is declared as returning void, but the compiler lets an asynchronous function
        // into such a type: without a catch its rejection would reach unhandledRejection and take the
        // process down.
        it("reports the rejection of an asynchronous listener", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const failure = new Error("listener is broken");
            const errors: unknown[] = [];

            cc.onError((error) => {
                errors.push(error);
            });
            cc.onChange("tempDir", async (): Promise<void> => {
                await sleep(1);

                throw failure;
            });

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);
            await waitFor(() => errors.length > 0);

            expect(errors).to.deep.equal([failure]);
        });

        // A listener of the error channel that threw is a failure too, and it goes to the same
        // channel. Otherwise the only trace of a broken logger would vanish silently.
        it("reports an error thrown by an error listener to the rest of them", async () => {
            const failing: ConfigBuilder<Values> = {
                build: (raw): Values => {
                    if (raw["TEMP_DIR"] === "/broken") {
                        throw new InvalidConfigError("the config is broken");
                    }

                    return fromRaw.build(raw);
                },
            };
            const { cc, storage } = await watched({ TEMP_DIR: "/data" }, failing);
            const failure = new Error("error listener is broken");
            const errors: unknown[] = [];

            cc.onError(() => {
                throw failure;
            });
            cc.onError((error) => {
                errors.push(error);
            });

            storage.raw = { TEMP_DIR: "/broken" };
            await signalled(storage);

            expect(errors).to.have.lengthOf(2);
            expect(errors[0]).to.be.instanceOf(InvalidConfigError);
            expect(errors[1]).to.equal(failure);
        });

        // Failures are delivered in exactly one round, past the listener that threw. Otherwise a
        // listener that always throws would spin the delivery forever.
        it("does not send an error listener its own failure", async () => {
            const failing: ConfigBuilder<Values> = {
                build: (raw): Values => {
                    if (raw["TEMP_DIR"] === "/broken") {
                        throw new InvalidConfigError("the config is broken");
                    }

                    return fromRaw.build(raw);
                },
            };
            const { cc, storage } = await watched({ TEMP_DIR: "/data" }, failing);
            let calls = 0;

            cc.onError(() => {
                calls += 1;

                throw new Error("error listener is broken");
            });

            storage.raw = { TEMP_DIR: "/broken" };
            await signalled(storage);

            expect(calls).to.equal(1);
        });

        // A listener is free to subscribe right inside the call. Walking a live set would call the
        // one that was added on the same change.
        it("does not call a listener that appeared during the same notification", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const calls: string[] = [];

            cc.onChange("tempDir", () => {
                calls.push("first");

                cc.onChange("tempDir", () => {
                    calls.push("second");
                });
            });

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);

            expect(calls).to.deep.equal(["first"]);

            storage.raw = { TEMP_DIR: "/data/third" };
            await signalled(storage);

            expect(calls).to.deep.equal(["first", "first", "second"]);
        });
    });
});
