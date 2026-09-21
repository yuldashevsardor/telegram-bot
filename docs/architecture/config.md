# Configuration

Configuration lives in `bootstrap/config/`. `ConfigContainer<Values>`
(`container/config-container.ts`) takes a `ConfigStorage` and a `ConfigBuilder<Values>` in its
constructor and assembles the values in `init()`: the storage hands over a snapshot of every
variable in one `load()` call (`RawConfig`), the builder parses and validates it and returns
`Values`, and the container keeps them and serves them through `get("bot.token")`. A `get()`
before `init()` is a `ConfigContainerIsNotInitialized`. In the application this is `CC` — a
`ConfigContainer<ConfigValues>` with a `ConfigValuesBuilder` and a `ConfigFileStorage` over a
`ConfigEnvStorage` (below, "Watching the file"), assembled by `ApplicationContext.create()`
([`application.md`](./application.md)). Neither `.env` nor the watched file expands `${...}`.

`init()` and `load()` are asynchronous although env hands over its variables straight away: the
other sources (a file, a vault) fetch values outside the process, and the interface did not have
to change for them. The storage is held by the container itself instead of handing it a ready
snapshot: a watchable source reports changes, and it is the container that rebuilds the values on
them. `ConfigEnvStorage.load()` calls `dotenv.config()` and returns a copy of `process.env`
rather than the object itself: an assembly sees the variables as they were at load time.

`ConfigValuesBuilder` (`builder/config-values-builder.ts`) is the schema of the application:
which variables exist, with which defaults and ranges. On every `build()` it creates a
`ConfigParser` (`parser/config-parser.ts`) over the given snapshot, and that parser reads strings
strictly: a default is substituted only for a missing or blank variable, while a value that is
set but not allowed fails the start with an `InvalidConfigError` naming the variable instead of
turning into the default. A string without a default is required; an integer is read only
together with a range. Deadlines and periods in milliseconds that end up in Node timers are read
by `getTimerDelay`: no more than 2147483647 ms, because Node turns anything larger into 1 ms, and
a deadline meant as "never" would fire at once. The pool deadlines, which are in seconds, are
read by `getInteger` with a ceiling of its own (the table below). Checks that tie several
variables together stay in `ConfigValuesBuilder`. The parsing helpers are public methods of a
separate class rather than private methods of the builder: a helper may have no call site yet
(that is how `getBoolean` and `getArray` came back), and `noUnusedLocals` does not let a private
method without calls through.

The shape of the values is passed to the container as an explicit generic with no constraint on
the type, and from that shape `Paths` and `ValueByPath` (`container/config-container.types.ts`)
derive the allowed paths and the result type of `get()`. The same file holds `ConfigPath` and
`ConfigValue` — the same types applied to `ConfigValues` (`shared/config-value.ts` takes them) —
the `CC` alias (a dependency on the container is always named `cc` and typed by it) and
`RawConfig`: the snapshot lives in the shared file rather than with the storage or the builder,
because both work with it and neither knows about the other.

The shape of the configuration as a whole is `config-values.ts`: `ConfigValues` and the types
declared for the config itself (`Environment`, `LoggerConfig`, `TelegramLimits`). The files of
`storage/` import from outside their directory only `dotenv`, `fs` with `fs/promises`, the
`RawConfig` type from the shared config types and `RuntimeError` for their own error: this is the
mechanics of the sources, and the second source was placed next to the first. That does not
guarantee isolation from the sides: `config-container.types.ts` imports the `ConfigContainer` and
`ConfigValues` types and through them pulls in the settings types of every side. The imports are
type-only, so at runtime they are gone. `ConfigValues` imports the settings types of every side
(the list is the imports of the file), which is why the directory belongs to the composition
root. Config keeps no copies of those types on purpose: the shape of the settings is declared
where it is consumed, a copy would have to be fixed twice, and a drift in an optional field would
be caught neither by the compiler nor by the tests.

There is one exception — `TelegramLimits`: it is declared in `config-values.ts`, and its consumer
`telegram/telegram-limit-resolver.ts` imports it from the composition root, so the arrow points
backwards.

## Watching the file

`ConfigFileStorage` (`storage/file/config-file-storage.ts`) is the second source: it reads a
`KEY=value` file through `dotenv.parse` and puts its values **under** the snapshot of the base
source it receives in its constructor (in the application that is `ConfigEnvStorage`). A variable
set in the environment beats the file, so neither editing the file nor swapping it takes the
application away from what it was configured with at startup (`docker-compose.app.yml`,
`env_file`). The price is that only what the environment does not hold can be changed on the fly:
a variable set to a non-blank value in `.env` does not yield to the file, whereas one declared
blank does, because a blank value does not count ([invariant](./invariants.md)). `dotenv.parse`
and not `dotenv.config()`: the latter writes into `process.env`, so taking a snapshot would edit
the environment of the process and the next read would see its own past values. Blank values
override nothing from either side: `ConfigParser` treats a blank string as a missing value
anyway, and were a blank one to override the file, a variable declared blank in `.env` (half of
them are) would forbid changing itself on the fly. The base source is asked first so that its
snapshot is taken on entry into `load()` rather than after the file has been read: otherwise the
assembly would see an environment that changed while the file was being read. A missing file is
not a failure: the snapshot is then assembled from the environment alone, and deleting the file
returns the values to it. An unreadable path (no permission, a directory in place of the file) is
a `ConfigFileUnreadable`: an empty set instead of a failure would drop every value of the file at
once, and the reason would stay unknown.

There are two interfaces. `ConfigStorage` (`storage/config-storage.ts`) is a single `load()`.
`WatchableConfigStorage` (`storage/watchable-config-storage.ts`) adds `watch(onChanged)` and
`unwatch()` and lives in a file of its own: there is nothing to watch in `process.env`, and a
vault ([#107](https://github.com/yuldashevsardor/telegram-bot/issues/107)) reports changes its
own way, so stubs in every source would be pointless. Interfaces do not exist at runtime, so
watchability is checked by the `isWatchableConfigStorage` guard
(`storage/config-storage.helper.ts`), and it checks both methods at once: a source with only one
of them would be watched by the container but could not be unwatched. `unwatch()` removes exactly
its own listener (`fs.unwatchFile` with a second argument): without it every listener of that
path in the process would go, including another instance watching the same file.

`watch()` polls the file through `fs.watchFile` instead of subscribing with `fs.watch`: the
application runs in a container with a bind mount, where inotify events from the host are not
guaranteed, and an editor saving through a temporary file with a rename moves the inode — and
`fs.watch` loses the file along with it. The `stat` snapshots are compared by modification time
and by size: on a missing file `watchFile` calls the listener right after the subscription, with
zeroes in both snapshots, and that call does not count as a change — a signal goes out for an
edit of the contents, for the appearance of the file (`mtime` out of zero), for its removal
(`mtime` back to zero) and for an edit that kept the time (visible by the size).

Such a comparison has a price: a write "in place" is not a single step. `fs.writeFile` with the
default flag, `echo … >` and `cat >` first truncate the file (`O_TRUNC`) and write the contents in
a second step, so a poll that lands between the steps sees a size of zero and calls the listener.
There is nothing to cut such a snapshot off by without losing a legitimate one: it differs from a
removal of the file only by a non-zero `mtime`, and by that same sign it is indistinguishable
from a deliberate truncation of the file to zero, which is legitimate — that is how values are
handed back to the base source without deleting the file. Such a signal lies only for as long as
it takes: it carries the fact alone, and the container assembles the values from a fresh read
(`ConfigContainer.rebuild()` calls `load()`), so an empty snapshot only comes out if `readFile`
itself landed in the same window; the next poll sees the completed file and rebuilds the values
again, so they can disagree with the file for no longer than the polling interval. The first
subscriber applying the value through `onChange()` is the one that notices the disagreement
([invariant](./invariants.md)). The specs protect themselves from a spurious signal: they edit a
watched file in a single step (`test/bootstrap/config/storage/config-file-storage.helper.ts`).

The watched file is `.runtime.env` in the project root; `CONFIG_FILE_PATH` changes the path. It
gets into the container through a bind mount of the same name (`docker-compose.app.yml`), and
that has a price: the mount holds on to the inode, so an edit "in place" arrives, while a save
through a temporary file with a rename (`vim` by default, `sed -i` without a suffix) does not —
the container stays on the old contents. The file itself is created before compose starts, by
`make` targets and `scripts/worktree-init.sh`: Docker would create a bind mount of a missing path
as a directory owned by root, and the start would fail with `ConfigFileUnreadable`. `.env` cannot
be watched this way at all: it does not get into the image (`.dockerignore`) and arrives as
variables through `env_file`, so inside the container there is no such file and its values are
already in `process.env`. `.runtime.env` itself is in `.gitignore` and `.dockerignore`, like
`.env`; what is kept in it is described in `.env.dist` next to `CONFIG_FILE_PATH`.

The path of the file and the polling interval are needed before the assembled configuration, so
`ApplicationContext` reads them from `process.env` — but through the same `ConfigParser`, which
is given that snapshot: the parsing rules stay in one place, and an interval that is not allowed
fails the start with an `InvalidConfigError` instead of turning into the default (watching that
has silently been switched off or sped up looks like watching that works). The interval is read
by `getTimerDelay` with a lower bound of 100 ms: configuration is not edited more often than
that, and a `stat` on every turn of the loop is not free. There is nothing to switch watching off
with — a source that is read is a source that is watched.

## Change subscriptions

On a signal from the source the container rebuilds the values the same way it did at startup:
`load()` → `build()`. The signal carries the fact of a change alone, so the priority of the
sources and the parsing stay in one place. The values are replaced whole and only after a
successful assembly — a failure of the builder leaves the previous ones working, and the reason
goes to the `onError()` listeners. The error channel is separate because the configuration has no
logger: it is assembled before one, and the logger subscribes to the channel later, in
`ApplicationContext` ([`application.md`](./application.md)). Rebuilds do not run in parallel:
while one is running the container has its state field filled, and the signals that arrive during
that time mark in the same field that one more pass is needed — all of them merge into that one
pass, because the snapshot is read whole and will see the latest state of the source. There is no
promise in the state: there is nobody to await a rebuild — it is never called from the outside,
and its only entrance is a signal from the source. `unwatch()` cancels it completely: a pass that
already stands on reading the snapshot does not replace the values — otherwise it would change
them under whoever reads them right after the stop (`Application.terminate()` takes the overall
deadline from there) — and it does not go for a second pass on a mark left by a signal that
arrived before the stop: the snapshot would then be read for an application that is shutting
down.

`onChange("limits.common", listener)` subscribes by the same dotted path that `get()` uses, with
the paths and the value type coming from `Paths` and `ValueByPath`; the listener receives the new
and the old value, and the return of `onChange()` is an unsubscribe function. Leaves are
compared: the builder creates new objects on every assembly, so comparing subtrees by reference
would report a change on every rebuild. A changed leaf notifies all of its prefixes as well, so a
subscription to `limits` fires on an edit of `limits.common.number`. The paths are collected into
a set, so a listener of a path gets exactly one call per rebuild, however many values inside its
subtree have changed. A listener that threw does not cancel the delivery to the rest, and its
failure goes to `onError()`; so does the rejection of an asynchronous listener's promise — by its
declaration a listener returns `void`, but the compiler lets an asynchronous function into such a
type, and without a catch its rejection would reach `unhandledRejection` in `app.ts`
([`application.md`](./application.md)).

What a rebuild changes in a running application is up to the subscribers: a value taken by
`configValue(...)` as the default of a constructor parameter stays as it was for that object
([invariant](./invariants.md)). Watching is switched on by `init()` together with the assembly of
the values, and switched off by the container's `unwatch()` — which `Application.terminate()`
calls before the overall shutdown deadline and outside it.

| Variable | Purpose (default) |
|---|---|
| `NODE_ENV` | the mode of the application (`development`); the logger adapter and the threshold depend on it ([`logging.md`](./logging.md)) |
| `CONFIG_FILE_PATH` | the watched file (`<root>/.runtime.env`); its values yield to the variables set in the environment |
| `CONFIG_FILE_WATCH_INTERVAL` | the polling interval of that file, ms (2000), an integer from 100 to 2147483647 |
| `BOT_TOKEN` | the bot token, required: a blank one fails the config assembly, and the `Bot` constructor checks it once more |
| `TEMP_DIR` | the temporary files of a conversion (`<root>/tmp`) |
| `FONT_FORGE_PATH` | the FontForge binary (`fontforge`) |
| `LIMIT_{COMMON,PRIVATE,GROUP}_{NUMBER,INTERVAL}` | the queue limits, the intervals in ms, both from 1 ([invariant](./invariants.md)); the defaults are in [`outbound-queue.md`](./outbound-queue.md) |
| `RUNNER_SLEEP_INTERVAL_MIN` / `RUNNER_SLEEP_INTERVAL_MAX` | the bounds of the random sleep of the Runner, ms; the defaults are in [`outbound-queue.md`](./outbound-queue.md); from 1 to 2147483647, the maximum not below the minimum |
| `RUNNER_MAX_RETRIES` | retries of a task before it is dropped (3), from 0 |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | the overall shutdown deadline (15000), up to 2147483647 and greater than the sum of the two below ([invariant](./invariants.md)) |
| `BOT_GRACEFUL_SHUTDOWN_TIMEOUT` | stopping the runner of the bot (3000), from 0 to 2147483647 |
| `TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT` | draining the queue (5000), from 0 to 2147483647, `0` means not to wait |
| `TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL` | the polling step of the queue (500), from 1 to 2147483647 |
| `TASK_QUEUE_LOG_INTERVAL` | the period of the `TaskQueue` info log: the number of tasks and partitions, and during a pause after a 429 what is left of it (10000), from 1 to 2147483647 |
| `LOGGER_LEVEL` | the logging threshold ([`logging.md`](./logging.md)) |
| `DATABASE_HOST/PORT/NAME/USER_NAME/USER_PASSWORD` | the connection, the port from 1 to 65535; inside compose the host and the port are set by `docker-compose.app.yml` |
| `DATABASE_CONNECTION_LIMIT/IDLE_TIMEOUT/MAX_LIFETIME` | the pool (10, 10 s, 600 s); the limit from 1, the deadlines from 0 to 2147483 s: `postgres.js` multiplies them by 1000 for a timer, and `0` switches the timer off |

`DATABASE_SUPERUSER_PASSWORD`, `DATABASE_TIMEZONE` and `DATABASE_DATE_STYLE` are read only by
`docker-compose.db.yml`; `DATABASE_SUPERUSER_NAME`, `DATABASE_USER_NAME`,
`DATABASE_USER_PASSWORD` and `DATABASE_NAME` are read on top of that by the first-run
initialisation script `docker/pgsql/docker-entrypoint-initdb.d/init-user-db.sh`. That script only
runs on an empty data directory: renaming any of them breaks not the current database but the
next one. The exception to that "only" is the test hook `test/database-hook.ts`: it creates the
database of a run as the superuser (`DATABASE_SUPERUSER_NAME`, `DATABASE_SUPERUSER_PASSWORD`)
from the same container environment, so a rename breaks the very next `make test` as well.
`DATABASE_URL` is read only by `node-pg-migrate`; it is assembled in `docker-compose.app.yml`,
because `.env` has no `${...}` substitution while Compose does have it in `environment:`.

There is an old `BOT_TOKEN` in the git history; it has been revoked and is dead, and the history
was deliberately not rewritten: after the revocation a rewrite would have broken clones and links
to commits, and the value would have stayed in forks and GitHub caches anyway. A repeat leak is
caught by secret scanning with push protection on the GitHub side (the environment variables
section of the root [`README.md`](../../README.md)) rather than by a `pre-commit` hook: that one
is bypassed with `--no-verify` and has no effect on other people's clones.
