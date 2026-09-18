import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { WatchableConfigStorage } from "app/bootstrap/config/storage/watchable-config-storage";

// Интерфейсы в рантайме не существуют, поэтому наблюдаемость источника проверяется по наличию
// метода: контейнер обязан работать и с источником, который об изменениях не сообщает.
export function isWatchableConfigStorage(storage: ConfigStorage): storage is WatchableConfigStorage {
    return typeof (storage as WatchableConfigStorage).watch === "function";
}
