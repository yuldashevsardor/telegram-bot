import type { RawConfig } from "app/bootstrap/config/container/config-container.types";

// A promise although env hands values over at once: a vault fetches them over the network.
export interface ConfigStorage {
    load(): Promise<RawConfig>;
}
