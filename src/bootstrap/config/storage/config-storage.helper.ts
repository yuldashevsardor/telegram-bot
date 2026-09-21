import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { WatchableConfigStorage } from "app/bootstrap/config/storage/watchable-config-storage";

// Interfaces do not exist at runtime, so the watchability of a source is checked by its methods —
// by both at once: a source with only one of them would be started by the container but could not
// be stopped. The container has to work with a source that reports no changes as well.
export function isWatchableConfigStorage(storage: ConfigStorage): storage is WatchableConfigStorage {
    const watchable = storage as WatchableConfigStorage;

    return typeof watchable.watch === "function" && typeof watchable.unwatch === "function";
}
