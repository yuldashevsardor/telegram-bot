import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { WatchableConfigStorage } from "app/bootstrap/config/storage/watchable-config-storage";

// Интерфейсов в рантайме нет, поэтому наблюдаемость источника проверяется по методам — обоим
// сразу: источник с одним из них контейнер завёл бы, но остановить не смог. Контейнер обязан
// работать и с источником, который об изменениях не сообщает.
export function isWatchableConfigStorage(storage: ConfigStorage): storage is WatchableConfigStorage {
    const watchable = storage as WatchableConfigStorage;

    return typeof watchable.watch === "function" && typeof watchable.unwatch === "function";
}
