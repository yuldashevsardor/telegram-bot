import fs from "fs";
import fsPromises from "fs/promises";
import * as dotenv from "dotenv";
import type { RawConfig } from "app/bootstrap/config/container/config-container.types";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { WatchableConfigStorage } from "app/bootstrap/config/storage/watchable-config-storage";
import { ConfigFileUnreadable } from "app/bootstrap/config/storage/file/config-file-storage.errors";

// A file under another source: only what the base source lacks or holds blank can change on the
// fly (docs/architecture/config.md, "Watching the file"). The base source comes as a parameter:
// built inside, it would make the file source repeat the work with process.env, and whoever ties
// them together would also have to know the order of the overlay.
export class ConfigFileStorage implements WatchableConfigStorage {
    private listener: ((current: fs.Stats, previous: fs.Stats) => void) | null = null;

    // The polling interval in milliseconds.
    public constructor(private readonly base: ConfigStorage, private readonly filePath: string, private readonly watchInterval: number) {}

    public async load(): Promise<RawConfig> {
        // The base source first: otherwise the assembly would see an environment that changed
        // while the file was being read.
        const base = await this.base.load();

        // Blank base values do not count, or a variable declared blank in .env could not be
        // changed on the fly.
        return { ...(await this.read()), ...ConfigFileStorage.withoutBlanks(base) };
    }

    public watch(onChanged: () => void): void {
        if (this.listener !== null) {
            return;
        }

        this.listener = (current: fs.Stats, previous: fs.Stats): void => {
            // Cuts off the first call on a missing file (zeroes in both snapshots) and a change of
            // the permissions alone (docs/architecture/config.md, "Watching the file").
            if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
                return;
            }

            onChanged();
        };

        // Polling by stat rather than fs.watch: polling keeps seeing the path across a bind mount
        // and a save through a rename (docs/architecture/config.md, "Watching the file").
        fs.watchFile(this.filePath, { interval: this.watchInterval }, this.listener);
    }

    // Exactly its own listener: unwatchFile without it would remove every listener of the path,
    // another instance's included. The cleared reference allows polling to start again.
    public unwatch(): void {
        if (this.listener === null) {
            return;
        }

        fs.unwatchFile(this.filePath, this.listener);
        this.listener = null;
    }

    // A missing file is not a failure: watching starts before it appears, and deleting it returns
    // the values to the base source. Anything else (no permission, a directory) is a failure: a
    // silent empty set would drop every value of the file at once.
    private async read(): Promise<RawConfig> {
        try {
            // Not dotenv.config(): it writes into process.env, and a reread would see its own past
            // values.
            return dotenv.parse(await fsPromises.readFile(this.filePath));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return {};
            }

            throw ConfigFileUnreadable.byPath(this.filePath, error);
        }
    }

    // A blank value means "nothing is set here": ConfigParser would take the default for it
    // anyway. So it overrides nothing, from either side of the overlay.
    private static withoutBlanks(parsed: RawConfig): RawConfig {
        return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined && value.trim() !== ""));
    }
}
