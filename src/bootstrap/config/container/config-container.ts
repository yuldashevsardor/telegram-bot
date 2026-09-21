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

// One state for the whole life cycle rather than flags: a set of flags allows combinations that do
// not happen ("a rebuild is running, but watching has already been removed"), and every check would
// have to enumerate them itself. idle means there is no watching: that is how the container lives
// before init() and where it returns after unwatch(), so a late signal (the callback of the watcher
// could have been queued before the stop) starts nothing. watching is set by init(), and only from
// there does a signal take the container into reloading. again is a signal that arrived while a
// rebuild was running: the file could have changed after the snapshot was read, so one more pass
// follows it, and all the signals of one pass merge into that one — the snapshot is read whole and
// will see the latest state of the source.
type State = { name: "idle" } | { name: "watching" } | { name: "reloading"; again: boolean };

// Keeps the values and serves them by path; where they come from and how they are validated is up
// to the storage and the builder. The assembly was moved out of the constructor into init(): a
// source may only be able to hand values over asynchronously (a vault), and a constructor cannot
// wait. A watchable source reports changes, and on its signal the container rebuilds the values the
// same way it did at startup — so the priority of the sources and the parsing stay in one place.
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

        // Watching is switched on right here rather than by a separate call: a separate one can be
        // forgotten, and the configuration would silently stay on the values of the startup. A
        // source that reports no changes (env, the fakes of the specs) is simply not watched.
        if (isWatchableConfigStorage(this.storage)) {
            this.storage.watch((): void => {
                void this.reload();
            });

            this.state = { name: "watching" };
        }
    }

    // Removes the watching: polling the file would hold the event loop, and a rebuild on an
    // application that is shutting down is of no use to anyone. A rebuild that is already running is
    // cancelled too: it is already reading the snapshot, and without the flag it would manage to
    // replace the values under whoever reads them next (`Application.terminate()` takes the shutdown
    // deadline one line below).
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

    // A change of a nested value calls the listener too: a subscription to "limits" fires on an edit
    // of "limits.common.number", because a changed leaf notifies all of its prefixes as well. However
    // many values inside a subtree have changed, the listener of its path gets one call.
    public onChange<Path extends Paths<Values> & string>(
        dottedPath: Path,
        listener: (newValue: ValueByPath<Values, Path>, oldValue: ValueByPath<Values, Path>) => void,
    ): Unsubscribe {
        // It is kept erased to a string and to unknown, so the pair of values is cast here — for the
        // same reason as the result of get(): the compiler checked the path but did not follow the
        // walk along it. The result of the listener is returned rather than dropped: by its
        // declaration it is void, but at runtime it can be the promise of an asynchronous listener,
        // and catching its rejection is up to the caller (call()).
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

        // Not watching means there should be no signal: it is left over from watching that has just
        // been removed, and there is no point in rebuilding the configuration for an application that
        // is shutting down.
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
    // field, and the mark about new signals has to be read from its own object rather than from
    // somebody else's state.
    private async reloadUntilSettled(reloading: { again: boolean }): Promise<void> {
        try {
            do {
                reloading.again = false;

                await this.rebuild();

                // The mark alone is not enough: it is left over from a signal that arrived before
                // unwatch(), and another pass would go and read the snapshot for an application that
                // is shutting down. The field is already taken by somebody else's state — so the
                // pass is not ours and there is nothing to continue.
            } while (reloading.again && this.state === reloading);
        } finally {
            // Watching could have been removed while the pass was running — the field is then
            // already taken by the state of the stop, and the container must not be returned to
            // watching.
            if (this.state === reloading) {
                this.state = { name: "watching" };
            }
        }
    }

    // The values are replaced whole and only after the assembly: a failure of the builder leaves the
    // previous ones working rather than half of the new ones. They are replaced before the delivery —
    // a get() inside a listener has to return the new value already. A failure goes to the error
    // channel rather than outwards: above lies the callback of the watcher, there is nowhere to throw.
    private async rebuild(): Promise<void> {
        try {
            const previous = this.currentValues();
            const raw = await this.storage.load();

            // Watching could have been removed while the snapshot was being read: the values must
            // not be replaced under whoever is already shutting the application down.
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
            // A listener is declared as returning void, but the compiler lets an asynchronous
            // function into such a type: without a catch its rejection would reach unhandledRejection
            // and take the process down.
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

    // Leaves are compared: the builder creates new objects on every assembly, so comparing subtrees
    // by reference would report a change of everything on every rebuild. The configuration is nested
    // (limits.common.number), so the walk is recursive; only the raw snapshot of the source is flat.
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

        // The path and all of its prefixes: a subscription to a subtree has to fire on a change
        // inside it. A set and not a list: two changed leaves of one subtree give its path once, so
        // the listener of the subtree is called once as well.
        let dottedPath = prefix;

        changed.add(dottedPath);

        while (dottedPath.includes(".")) {
            dottedPath = dottedPath.slice(0, dottedPath.lastIndexOf("."));

            changed.add(dottedPath);
        }
    }

    // undefined means "there is no value at this path": either a step of the path ran into a leaf
    // and there is nowhere further to go, or the key is not in the object. The value that was found is
    // returned as is — what to do with it next is up to the caller: get() turns undefined into an
    // InvalidConfigError, and the comparison treats it as a missing value.
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
