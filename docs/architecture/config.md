# Configuration

Configuration lives in `bootstrap/config/`. `ConfigContainer<Values>`
(`container/config-container.ts`) takes a `ConfigStorage` and a `ConfigBuilder<Values>` in its
constructor and assembles the values in `init()`:

1. the storage hands over a snapshot of every variable in one `load()` call (`RawConfig`);
2. the builder parses and validates it and returns `Values`;
3. the container keeps them and serves them through `get("bot.token")`.

A `get()` before `init()` throws `ConfigContainerIsNotInitialized`. The application uses `CC`: a
`ConfigContainer<ConfigValues>` with a `ConfigValuesBuilder` and a `ConfigFileStorage` over a
`ConfigEnvStorage` ("Watching the file" below). `ApplicationContext.create()` assembles it
([`application.md`](./application.md)). Neither `.env` nor the watched file expands `${...}`.

`init()` and `load()` are asynchronous, although env hands over its variables at once. Other
sources (a file, a vault) fetch values from outside the process, and the interface did not have to
change for them. The container holds the storage rather than a ready snapshot, because a watchable
source reports changes and the container rebuilds the values on them. `ConfigEnvStorage.load()`
calls `dotenv.config()` and returns a copy of `process.env`, not the object itself, so an assembly
sees the variables as they were at load time.

`ConfigValuesBuilder` (`builder/config-values-builder.ts`) is the schema of the application: which
variables exist, with which defaults and ranges. Checks that tie several variables together live
there too. On every `build()` it creates a `ConfigParser` (`parser/config-parser.ts`) over the
snapshot, and the parser reads strings strictly:

- A default replaces only a missing or blank variable. A value that is set but not allowed fails
  the start with an `InvalidConfigError` naming the variable; it does not turn into the default.
- A string without a default is required.
- An integer is read only together with a range.
- Deadlines and periods in milliseconds that end up in Node timers are read by `getTimerDelay`, at
  most 2147483647 ms. Node turns anything larger into 1 ms, so a deadline meant as "never" would
  fire at once.
- The pool deadlines are in seconds, so `getInteger` reads them with a ceiling of their own
  (`ConfigValuesBuilder.DATABASE_TIMER_RANGE`).

The parsing helpers are public methods of a separate class, not private methods of the builder. A
helper may have no call site yet (that is how `getBoolean` and `getArray` came back), and
`noUnusedLocals` rejects a private method without calls.

The container takes the shape of the values as an explicit generic with no constraint on the type.
From that shape `Paths` and `ValueByPath` (`container/config-container.types.ts`) derive the
allowed paths and the result type of `get()`. The same file holds:

- `ConfigPath` and `ConfigValue`: the same types applied to `ConfigValues`
  (`shared/config-value.ts` takes them);
- the `CC` alias: a dependency on the container is always named `cc` and typed by it;
- `RawConfig`: the storage and the builder both work with the snapshot and neither knows about the
  other, so it lives in the shared file.

`config-values.ts` is the shape of the configuration as a whole: `ConfigValues` and the types
declared for the config itself (`Environment`, `LoggerConfig`, `TelegramLimits`). `ConfigValues`
imports the settings types of every side (the list is the imports of the file), so the directory
belongs to the composition root. Config keeps no copies of those types on purpose. The shape of
the settings is declared where it is consumed. A copy would have to be fixed twice, and neither
the compiler nor the tests would catch a drift in an optional field. The one exception is
`TelegramLimits`: it is declared in `config-values.ts`, and its consumer
`telegram/telegram-limit-resolver.ts` imports it from the composition root, so the arrow points
backwards.

The files of `storage/` import from outside their directory only `dotenv`, `fs` with
`fs/promises`, the `RawConfig` type and `RuntimeError` for their own error. They are the mechanics
of the sources, and the second source was placed next to the first. This does not isolate them
from the sides: `RawConfig` lives in `config-container.types.ts`, which imports the
`ConfigContainer` and `ConfigValues` types and through them the settings types of every side. The
imports are type-only, so they are gone at runtime.

## Watching the file

`ConfigFileStorage` (`storage/file/config-file-storage.ts`) is the second source. It reads a
`KEY=value` file through `dotenv.parse` and lays its values **under** the snapshot of the base
source from its constructor (`ConfigEnvStorage` in the application). A variable set in the
environment beats the file. So neither an edit of the file nor a swap of it takes the application
away from what it was configured with at startup (`docker-compose.app.yml`, `env_file`). The price:
only what the environment does not hold can change on the fly. A variable set to a non-blank value
in `.env` does not yield to the file, while one declared blank does
([invariant](./invariants.md)).

How `load()` builds the snapshot:

- Blank values override nothing, from either side. `ConfigParser` treats a blank string as a
  missing value anyway. Were a blank one to override the file, a variable declared blank in `.env`
  (as `.env.dist` does with `TEMP_DIR`) could not be changed on the fly.
- `dotenv.parse`, not `dotenv.config()`: the latter writes into `process.env`. Taking a snapshot
  would then edit the environment of the process, and the next read would see its own past values.
- The base source is asked first, so its snapshot is taken on entry into `load()`. Otherwise the
  assembly would see an environment that changed while the file was being read.
- A missing file is not a failure: the snapshot then comes from the environment alone, and
  deleting the file returns the values to it.
- An unreadable path (no permission, a directory in place of the file) throws
  `ConfigFileUnreadable`. An empty set instead would drop every value of the file at once, and the
  reason would stay unknown.

There are two interfaces. `ConfigStorage` (`storage/config-storage.ts`) is a single `load()`.
`WatchableConfigStorage` (`storage/watchable-config-storage.ts`) adds `watch(onChanged)` and
`unwatch()` in a file of its own. There is nothing to watch in `process.env`, and a vault
([#107](https://github.com/yuldashevsardor/telegram-bot/issues/107)) reports changes its own way,
so stubs in every source would be pointless. Interfaces do not exist at runtime, so the
`isWatchableConfigStorage` guard (`storage/config-storage.helper.ts`) checks the methods. It checks
both at once: a source with only one of them would be watched by the container but could not be
unwatched. `unwatch()` removes exactly its own listener (`fs.unwatchFile` with a second argument).
Without it every listener of that path in the process would go, including another instance
watching the same file.

`watch()` polls the file through `fs.watchFile` rather than subscribing with `fs.watch`. The
application runs in a container with a bind mount, where inotify events from the host are not
guaranteed. An editor that saves through a temporary file and a rename moves the inode, and
`fs.watch` loses the file along with it.

The listener compares the `stat` snapshots by modification time and by size. On a missing file
`watchFile` calls it right after the subscription with zeroes in both snapshots, and that call is
not a change. A signal goes out for:

- an edit of the contents;
- the appearance of the file (`mtime` out of zero);
- its removal (`mtime` back to zero);
- an edit that kept the time (visible by the size).

The comparison has a price: a write "in place" takes two steps. `fs.writeFile` with the default
flag, `echo … >` and `cat >` first truncate the file (`O_TRUNC`) and write the contents in a second
step. A poll that lands between the steps sees a size of zero and calls the listener. Such a
snapshot cannot be cut off without losing a legitimate one. It differs from a removal of the file
only by a non-zero `mtime`. By that same sign it cannot be told from a deliberate truncation to
zero, which is legitimate: that is how values are handed back to the base source without deleting
the file.

Such a signal lies only briefly. It carries the fact of a change alone, and the container assembles
the values from a fresh read (`ConfigContainer.rebuild()` calls `load()`). So an empty snapshot
comes out only if `readFile` itself lands in the same window. The next poll sees the completed file
and rebuilds the values again, so they disagree with the file for no longer than the polling
interval. The first subscriber that applies the value through `onChange()` is the one that will
notice the disagreement ([invariant](./invariants.md)). The specs avoid the spurious signal: they
edit a watched file in a single step
(`test/bootstrap/config/storage/config-file-storage.helper.ts`).

The watched file is `.runtime.env` in the project root; `CONFIG_FILE_PATH` changes the path.
`.runtime.env` is in `.gitignore` and `.dockerignore`, like `.env`. What is kept in it is described
in `.env.dist` next to `CONFIG_FILE_PATH`.

- It gets into the container through a bind mount of the same name (`docker-compose.app.yml`). The
  mount holds on to the inode. An edit "in place" arrives, while a save through a temporary file
  with a rename (`vim` by default, `sed -i` without a suffix) does not: the container stays on the
  old contents.
- `make` targets and `scripts/worktree-init.sh` create the file before compose starts. Docker would
  create a bind mount of a missing path as a directory owned by root, and the start would fail with
  `ConfigFileUnreadable`.
- `.env` cannot be watched this way. It does not get into the image (`.dockerignore`) and arrives as
  variables through `env_file`. Inside the container there is no such file, and its values are
  already in `process.env`.

`ApplicationContext` needs the path of the file and the polling interval before the configuration
is assembled, so it reads them from `process.env`. It reads them through the same `ConfigParser`,
so the parsing rules stay in one place. An interval that is not allowed fails the start with an
`InvalidConfigError` rather than turning into the default: watching silently switched off or sped up
looks like watching that works. `getTimerDelay` reads the interval with a lower bound of 100 ms.
Configuration is not edited more often than that, and a `stat` on every turn of the loop is not
free. Watching cannot be switched off: a source that is read is a source that is watched.

## Change subscriptions

On a signal from the source the container rebuilds the values the same way it did at startup:
`load()` → `build()`. The signal carries the fact of a change alone, so the priority of the sources
and the parsing stay in one place. The values are replaced whole and only after a successful
assembly. A failure of the builder leaves the previous values working and sends the reason to the
`onError()` listeners. The error channel is separate because the configuration has no logger: it is
assembled before one. The logger subscribes to the channel later, in `ApplicationContext`
([`application.md`](./application.md)).

Rebuilds do not run in parallel:

- While a rebuild runs, the state field of the container says so. A signal that arrives meanwhile
  marks in the same field that one more pass is needed.
- All such signals merge into that one pass: the snapshot is read whole and will see the latest
  state of the source.
- There is no promise in the state, because nobody awaits a rebuild. It is never called from the
  outside; its only entrance is a signal from the source.

`unwatch()` cancels a rebuild completely:

- A pass that is already reading the snapshot does not replace the values. Otherwise it would
  change them under whoever reads them right after the stop (`Application.terminate()` takes the
  overall deadline from there).
- A mark left by a signal that arrived before the stop does not start a second pass: the snapshot
  would be read for an application that is shutting down.

`onChange("limits.common", listener)` subscribes by the same dotted path that `get()` uses, with
the paths and the value type coming from `Paths` and `ValueByPath`. The listener receives the new
and the old value. `onChange()` returns an unsubscribe function. How changes are delivered:

- Leaves are compared. The builder creates new objects on every assembly, so comparing subtrees by
  reference would report a change on every rebuild.
- A changed leaf notifies all of its prefixes as well: a subscription to `limits` fires on an edit
  of `limits.common.number`.
- The paths are collected into a set, so a listener of a path gets exactly one call per rebuild,
  however many values inside its subtree have changed.
- A listener that threw does not cancel the delivery to the rest, and its failure goes to
  `onError()`.
- The rejection of an asynchronous listener's promise goes to `onError()` too. By its declaration
  a listener returns `void`, but the compiler lets an asynchronous function into such a type.
  Without a catch its rejection would reach `unhandledRejection` in `app.ts`
  ([`application.md`](./application.md)).

What a rebuild changes in a running application is up to the subscribers. A value taken by
`configValue(...)` as the default of a constructor parameter stays as it was for that object
([invariant](./invariants.md)). `init()` switches watching on together with the assembly of the
values. The container's `unwatch()` switches it off, and `Application.terminate()` calls it before
the overall shutdown deadline and outside it.

## Environment variables

Every variable is described in `.env.dist`, next to its value: its purpose, unit and range. The
defaults and the checks are in `ConfigValuesBuilder`, and for the two `CONFIG_FILE_`
variables in `ApplicationContext.createStorage()`.

There is an old `BOT_TOKEN` in the git history, in `.env.dist`. It has been revoked and is dead.
The history was deliberately not rewritten: after the revocation a rewrite would have broken clones
and links to commits, and the value would have stayed in forks and GitHub caches anyway. A repeat
leak is caught on the GitHub side, by secret scanning with push protection (the environment
variables section of the root [`README.md`](../../README.md)). A `pre-commit` hook would not do:
it is bypassed with `--no-verify` and has no effect on other people's clones.
