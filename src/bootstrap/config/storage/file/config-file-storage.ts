import fs from "fs";
import fsPromises from "fs/promises";
import * as dotenv from "dotenv";
import type { RawConfig } from "app/bootstrap/config/container/config-container.types";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { WatchableConfigStorage } from "app/bootstrap/config/storage/watchable-config-storage";
import { ConfigFileUnreadable } from "app/bootstrap/config/storage/file/config-file-storage.errors";

// A file under another source: what the base source holds overrides the file, so what can be
// changed on the fly is what the base source does not hold (a blank variable is a "does not").
// The base source comes as a parameter instead of being built inside, otherwise the file source
// would repeat the work with process.env and whoever ties them together would have to know the
// order of the overlay as well.
export class ConfigFileStorage implements WatchableConfigStorage {
    private listener: ((current: fs.Stats, previous: fs.Stats) => void) | null = null;

    // The polling interval in milliseconds.
    public constructor(private readonly base: ConfigStorage, private readonly filePath: string, private readonly watchInterval: number) {}

    public async load(): Promise<RawConfig> {
        // The base source is asked first: its snapshot has to be taken on entry into load() rather
        // than after the file has been read, otherwise the assembly would see an environment that
        // changed while the file was being read.
        const base = await this.base.load();

        // The blank values of the base source do not count: ConfigParser treats them as missing
        // anyway, and were they to override the file, a variable declared blank in .env (half of
        // them are) would forbid changing its value on the fly.
        return { ...(await this.read()), ...ConfigFileStorage.withoutBlanks(base) };
    }

    public watch(onChanged: () => void): void {
        if (this.listener !== null) {
            return;
        }

        this.listener = (current: fs.Stats, previous: fs.Stats): void => {
            // On a missing file watchFile calls the listener right after the subscription, with
            // zeroes in both snapshots; the comparison cuts off that call and a change of the
            // permissions alone, leaving an edit of the contents, the appearance of the file
            // (mtime out of zero) and its removal (mtime back to zero).
            if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
                return;
            }

            onChanged();
        };

        // Polling by stat rather than fs.watch: the application runs in a container with a bind
        // mount, where inotify events from the host are not guaranteed, and an editor saving
        // through a temporary file with a rename moves the inode — fs.watch loses the file along
        // with it, while polling keeps seeing the path.
        fs.watchFile(this.filePath, { interval: this.watchInterval }, this.listener);
    }

    // Exactly its own listener is removed: unwatchFile without it would remove everyone from that
    // path, including another instance watching the same file. The cleared reference gives back
    // the right to start polling again.
    public unwatch(): void {
        if (this.listener === null) {
            return;
        }

        fs.unwatchFile(this.filePath, this.listener);
        this.listener = null;
    }

    // A missing file is not a failure: watching starts before it appears, and deleting it returns
    // the values to the base source. Everything else (no permission, the path turned out to be a
    // directory) is a failure: an empty set substituted silently would drop every value of the
    // file at once.
    private async read(): Promise<RawConfig> {
        try {
            // dotenv.parse and not dotenv.config(): the latter writes into process.env, so taking
            // a snapshot would edit the environment of the process and a reread would see its own
            // past values.
            return dotenv.parse(await fsPromises.readFile(this.filePath));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return {};
            }

            throw ConfigFileUnreadable.byPath(this.filePath, error);
        }
    }

    // A blank value means "nothing is set here", not "set to blank": blankness cannot be set with
    // it anyway — ConfigParser treats it as missing and takes the default. So a blank string
    // overrides nothing, from whichever side of the overlay it comes.
    private static withoutBlanks(parsed: RawConfig): RawConfig {
        return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined && value.trim() !== ""));
    }
}
