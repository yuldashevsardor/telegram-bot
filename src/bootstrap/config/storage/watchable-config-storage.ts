import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";

// Источник, который сам сообщает об изменениях. Отдельным интерфейсом, а не методом в
// ConfigStorage: за process.env следить нечем, а vault сообщает об изменениях своим способом, и
// обязывать каждый источник к watch() значило бы держать в нём заглушку.
export interface WatchableConfigStorage extends ConfigStorage {
    // Сообщает только факт изменения: снимок перечитывает контейнер тем же load(), что и на
    // старте, — иначе приоритет источников пришлось бы собирать в двух местах.
    watch(onChanged: () => void): void;
}
