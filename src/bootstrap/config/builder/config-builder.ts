import type { RawConfig } from "app/bootstrap/config/container/config-container.types";

// The schema of the configuration: assembles values of the shape Values from a snapshot of the
// source and validates them.
export interface ConfigBuilder<Values> {
    build(raw: RawConfig): Values;
}
