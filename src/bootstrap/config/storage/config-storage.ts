import type { RawConfig } from "app/bootstrap/config/config-container.types";

// Промис — под источники, которые отдают значения по сети (vault), даже если env отдаёт их сразу.
export interface ConfigStorage {
    load(): Promise<RawConfig>;
}

// Наблюдение — отдельным интерфейсом, а не парой методов в ConfigStorage: за process.env следить
// нечем, а vault сообщает об изменениях своим способом, и обязывать каждый источник к этим
// методам значило бы держать в нём заглушки.
export interface WatchableConfigStorage extends ConfigStorage {
    // Сообщает только факт изменения: снимок перечитывает контейнер тем же load(), что и на
    // старте, — иначе приоритет источников пришлось бы собирать в двух местах.
    watch(onChanged: () => void): void;

    unwatch(): void;
}

export function isWatchableConfigStorage(storage: ConfigStorage): storage is WatchableConfigStorage {
    return typeof (storage as WatchableConfigStorage).watch === "function";
}
