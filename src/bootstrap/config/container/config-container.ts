import type { UnknownObject } from "app/shared/types";
import { InvalidConfigError } from "app/shared/errors";
import type {
    ConfigChangeListener,
    ConfigErrorListener,
    Paths,
    Unsubscribe,
    ValueByPath,
} from "app/bootstrap/config/container/config-container.types";
import type { ConfigBuilder } from "app/bootstrap/config/builder/config-builder";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import { isWatchableConfigStorage } from "app/bootstrap/config/storage/config-storage.helper";
import { ConfigContainerIsNotInitialized } from "app/bootstrap/config/container/config-container.errors";

// One state rather than flags: flags allow combinations that do not happen ("a rebuild is running,
// but watching has already been removed"), and every check would have to enumerate them.
// - idle: no watching, before init() and after unwatch(). A late signal (the watcher callback could
//   have been queued before the stop) starts nothing.
// - watching: set by init(); only from here does a signal start reloading.
// - again: a signal during a rebuild. The file could have changed after the snapshot was read, so
//   one more pass follows (docs/architecture/config.md, "Change subscriptions").
type State = { name: "idle" } | { name: "watching" } | { name: "reloading"; again: boolean };

// Keeps the values and serves them by path; the storage and the builder decide where they come
// from and how they are validated. The assembly is in init(), not in the constructor: a source may
// hand values over only asynchronously (a vault), and a constructor cannot wait. Rebuilds on a
// signal: docs/architecture/config.md, "Change subscriptions".
export class ConfigContainer<Values> {
    private values: Values | null = null;

    // The listeners are keyed by the path string: the comparison yields the paths that changed, not
    // references to subscriptions.
    private readonly changeListeners = new Map<string, Set<ConfigChangeListener>>();
    private readonly errorListeners = new Set<ConfigErrorListener>();

    private state: State = { name: "idle" };

    public constructor(private readonly storage: ConfigStorage, private readonly builder: ConfigBuilder<Values>) {}

    public async init(): Promise<void> {
        this.values = this.builder.build(await this.storage.load());

        // Watching starts here, not by a separate call: a separate call can be forgotten, and the
        // configuration would silently stay on the startup values. A source that reports no changes
        // (env, the fakes of the specs) is not watched.
        if (isWatchableConfigStorage(this.storage)) {
            this.storage.watch((): void => {
                void this.reload();
            });

            this.state = { name: "watching" };
        }
    }

    // Polling the file would hold the event loop, and a rebuild is of no use to an application that
    // is shutting down. A running rebuild is cancelled too (docs/architecture/config.md, "Change
    // subscriptions").
    public unwatch(): void {
        this.state = { name: "idle" };

        if (isWatchableConfigStorage(this.storage)) {
            this.storage.unwatch();
        }
    }

    public get<Path extends Paths<Values> & string>(dottedPath: Path): ValueByPath<Values, Path> {
        const value = this.valueAt(this.currentValues(), dottedPath);

        // The path has been checked by the compiler, so what leads here is not a typo in it but a
        // drift between the declared shape of the configuration and the real one — an optional field
        // that became undefined.
        if (value === undefined) {
            throw new InvalidConfigError(`Invalid config "${dottedPath}"`, {
                path: dottedPath,
            });
        }

        // Casting the result: the compiler cannot follow a walk by dots, but it has already checked
        // the path against Values, and ValueByPath derives the type from the same place the value
        // came from.
        return value as ValueByPath<Values, Path>;
    }

    // A listener of a subtree fires on a change inside it too, once per rebuild
    // (docs/architecture/config.md, "Change subscriptions").
    public onChange<Path extends Paths<Values> & string>(
        dottedPath: Path,
        listener: (newValue: ValueByPath<Values, Path>, oldValue: ValueByPath<Values, Path>) => void,
    ): Unsubscribe {
        // The listener is kept erased to a string and to unknown, so the pair of values is cast here,
        // as in get(). The result is returned, not dropped: an asynchronous listener returns a
        // promise, and call() catches its rejection.
        const stored: ConfigChangeListener = (newValue, oldValue): void =>
            listener(newValue as ValueByPath<Values, Path>, oldValue as ValueByPath<Values, Path>);

        const listeners = this.changeListeners.get(dottedPath) ?? new Set<ConfigChangeListener>();

        listeners.add(stored);
        this.changeListeners.set(dottedPath, listeners);

        return (): void => {
            listeners.delete(stored);
        };
    }

    public onError(listener: ConfigErrorListener): Unsubscribe {
        this.errorListeners.add(listener);

        return (): void => {
            this.errorListeners.delete(listener);
        };
    }

    private reload(): void {
        if (this.state.name === "reloading") {
            this.state.again = true;

            return;
        }

        // Not watching: the signal is left over from watching that has just been removed, and the
        // application is shutting down.
        if (this.state.name !== "watching") {
            return;
        }

        // Stryker disable next-line BooleanLiteral: `true` is equivalent: a pass of the loop clears the mark on its own entry, so the initial value does not survive until the first rebuild
        const reloading: State = { name: "reloading", again: false };

        this.state = reloading;

        // The pass has no rejection: rebuild() sends its errors to the error channel, because above
        // lies the callback of the watcher — a rejection from there would become an unhandledRejection.
        void this.reloadUntilSettled(reloading);
    }

    // The state of the pass comes as a parameter: an unwatch() in the middle of it replaces the
    // field, and the mark has to be read from the pass's own object.
    private async reloadUntilSettled(reloading: { again: boolean }): Promise<void> {
        try {
            do {
                reloading.again = false;

                await this.rebuild();

                // The mark alone is not enough: it may be left by a signal from before unwatch().
                // A field holding another state means the pass is no longer ours.
            } while (reloading.again && this.state === reloading);
        } finally {
            // An unwatch() during the pass replaced the field; the container must not go back to
            // watching.
            if (this.state === reloading) {
                this.state = { name: "watching" };
            }
        }
    }

    // The values are replaced whole, after the assembly: a failed build leaves the previous ones, not
    // half of the new. They are replaced before the delivery, so a get() inside a listener already
    // returns the new value. A failure goes to the error channel: above lies the watcher callback,
    // with nowhere to throw to.
    private async rebuild(): Promise<void> {
        try {
            const previous = this.currentValues();
            const raw = await this.storage.load();

            // An unwatch() during the read: do not replace the values under whoever is shutting
            // the application down.
            if (this.state.name !== "reloading") {
                return;
            }

            const current = this.builder.build(raw);

            this.values = current;

            this.notifyChanges(previous, current);
        } catch (error) {
            this.notifyError(error);
        }
    }

    private notifyChanges(previous: Values, current: Values): void {
        const changed = new Set<string>();

        this.collectChanges(previous, current, "", changed);

        for (const dottedPath of changed) {
            const listeners = this.changeListeners.get(dottedPath);

            if (listeners === undefined) {
                continue;
            }

            const newValue = this.valueAt(current, dottedPath);
            const oldValue = this.valueAt(previous, dottedPath);

            // A copy of the set: a listener is free to subscribe or to detach right inside the call,
            // and walking a live Set would see what was added and call it on the same change.
            for (const listener of [...listeners]) {
                this.call(listener, newValue, oldValue);
            }
        }
    }

    private call(listener: ConfigChangeListener, newValue: unknown, oldValue: unknown): void {
        try {
            // The compiler lets an asynchronous function into a void listener: without a catch its
            // rejection would reach unhandledRejection and take the process down.
            const result: unknown = listener(newValue, oldValue);

            if (result instanceof Promise) {
                result.catch((error: unknown): void => {
                    this.notifyError(error);
                });
            }
        } catch (error) {
            // A listener that threw does not cancel the delivery to the rest: they do not know about
            // each other.
            this.notifyError(error);
        }
    }

    private notifyError(error: unknown): void {
        const failures = this.callErrorListeners(error);

        // A listener of the error channel that threw is a failure too, and it goes to the same
        // channel, past the one that threw. Exactly once: the failures of this delivery go nowhere
        // any more, otherwise a listener that always throws would spin it forever.
        for (const [failed, failure] of failures) {
            this.callErrorListeners(failure, failed);
        }
    }

    private callErrorListeners(error: unknown, skip?: ConfigErrorListener): Array<[ConfigErrorListener, unknown]> {
        const failures: Array<[ConfigErrorListener, unknown]> = [];

        for (const listener of [...this.errorListeners]) {
            if (listener === skip) {
                continue;
            }

            try {
                listener(error);
            } catch (failure) {
                failures.push([listener, failure]);
            }
        }

        return failures;
    }

    private currentValues(): Values {
        if (this.values === null) {
            throw new ConfigContainerIsNotInitialized("ConfigContainer is not initialized, call init() first.");
        }

        return this.values;
    }

    // Leaves are compared, not subtrees (docs/architecture/config.md, "Change subscriptions"). The
    // configuration is nested (limits.common.number), so the walk is recursive; only the raw
    // snapshot of the source is flat.
    private collectChanges(previous: unknown, current: unknown, prefix: string, changed: Set<string>): void {
        if (this.isObject(previous) && this.isObject(current)) {
            for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
                this.collectChanges(previous[key], current[key], prefix === "" ? key : `${prefix}.${key}`, changed);
            }

            return;
        }

        if (previous === current) {
            return;
        }

        // The path and all of its prefixes, so a subscription to a subtree fires on a change inside
        // it. A set: two changed leaves of one subtree give its path once.
        let dottedPath = prefix;

        changed.add(dottedPath);

        while (dottedPath.includes(".")) {
            dottedPath = dottedPath.slice(0, dottedPath.lastIndexOf("."));

            changed.add(dottedPath);
        }
    }

    // undefined means "no value at this path": a step ran into a leaf, or the key is not in the
    // object. The caller decides: get() turns undefined into an InvalidConfigError, and the
    // comparison treats it as a missing value.
    private valueAt(values: unknown, dottedPath: string): unknown {
        let current = values;

        for (const key of dottedPath.split(".")) {
            if (!this.isObject(current)) {
                return undefined;
            }

            current = current[key];
        }

        return current;
    }

    // typeof null is "object" too: without a separate check for null the walk would fail with a
    // TypeError.
    private isObject(value: unknown): value is UnknownObject {
        return value !== null && typeof value === "object";
    }
}
