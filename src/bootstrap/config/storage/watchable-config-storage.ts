import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";

// A source that reports changes itself. A separate interface rather than a pair of methods in
// ConfigStorage: there is nothing to watch in process.env, a vault reports changes its own way,
// and there is no point in obliging every source to stub watch()/unwatch().
export interface WatchableConfigStorage extends ConfigStorage {
    // Reports the fact of a change alone: the container rereads the snapshot with the same load()
    // it used at startup — otherwise the priority of the sources would live in two places.
    watch(onChanged: () => void): void;

    unwatch(): void;
}
