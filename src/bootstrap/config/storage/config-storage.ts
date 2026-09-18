import type { RawConfig } from "app/bootstrap/config/config-container.types";

// Промис — под источники, которые отдают значения по сети (vault), даже если env отдаёт их сразу.
export interface ConfigStorage {
    load(): Promise<RawConfig>;
}
