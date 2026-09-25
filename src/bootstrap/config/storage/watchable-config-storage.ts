import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";

// A source that reports changes itself. Not a part of ConfigStorage: process.env has nothing to
// watch, a vault reports changes its own way, and every source would have to stub the methods.
export interface WatchableConfigStorage extends ConfigStorage {
    // Reports the fact of a change alone: the container rereads the snapshot with the same load() as
    // at startup, so the priority of the sources lives in one place.
    watch(onChanged: () => void): void;

    unwatch(): void;
}
