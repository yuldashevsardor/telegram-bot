import type { RawConfig } from "app/bootstrap/config/container/config-container.types";

// The promise is for sources that hand values over the network (a vault), even though env hands
// them over straight away.
export interface ConfigStorage {
    load(): Promise<RawConfig>;
}
