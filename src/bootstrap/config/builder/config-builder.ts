import type { RawConfig } from "app/bootstrap/config/config-container/config-container.types";

// Схема конфигурации: из снимка источника собирает значения формы Values и валидирует их.
export interface ConfigBuilder<Values> {
    build(raw: RawConfig): Values;
}
