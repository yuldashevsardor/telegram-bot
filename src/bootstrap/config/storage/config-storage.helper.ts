import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { WatchableConfigStorage } from "app/bootstrap/config/storage/watchable-config-storage";

// Interfaces do not exist at runtime, so both methods are checked: a source with only one of them
// would be watched but could not be unwatched. The container also works with sources that report
// no changes.
export function isWatchableConfigStorage(storage: ConfigStorage): storage is WatchableConfigStorage {
    const watchable = storage as WatchableConfigStorage;

    return typeof watchable.watch === "function" && typeof watchable.unwatch === "function";
}
