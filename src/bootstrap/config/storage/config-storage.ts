import type { RawConfig } from "app/bootstrap/config/config-container.types";

export interface ConfigStorage {
    // Промис — под источники, которые отдают значения по сети (vault), даже если env отдаёт их сразу.
    load(): Promise<RawConfig>;

    // Освобождает всё, что источник держит между вызовами load(): опрос файла, соединение с
    // vault. Объявлен здесь, а не у наблюдаемых источников: остановка — забота любого источника,
    // и вызывающему не нужно знать, есть ли ей что делать.
    stop(): void;
}
