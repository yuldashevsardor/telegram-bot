# Architecture

The directory describes the code as it is, known problems included. A problem is marked in place
with a link to its issue. Found a new one — describe it in the file of its subsystem and file an
issue. There is deliberately no summary list of problems here: the tracker is that list.

The runtime sequences live in the files of their subsystems:

- start and stop — [`application.md`](./application.md);
- an incoming update — [`inbox.md`](./inbox.md) from Telegram to the handler, then the pipeline of
  [`bot.md`](./bot.md);
- the commands — [`bot.md`](./bot.md);
- an outgoing call — [`bot.md`](./bot.md), "The outbox transformer", and
  [`outbox.md`](./outbox.md);
- loading the locales — [`i18n.md`](./i18n.md).

## Contents

One line per file on what it is about. The sections of a file are its headings, and the
directories it covers are in the directory map below.

- [`application.md`](./application.md) — DI and the lifecycle of the process
- [`bot.md`](./bot.md) — the update pipeline of the bot and its commands
- [`outbox.md`](./outbox.md) — the outbox of outgoing Bot API calls in PostgreSQL
- [`outbox-load-test.md`](./outbox-load-test.md) — the outbox store measured on 100 M messages and
  on 280 M skewed ones
- [`inbox.md`](./inbox.md) — the inbox of incoming updates in PostgreSQL
- [`inbox-load-test.md`](./inbox-load-test.md) — the inbox store measured on 100 M updates and on
  250 M skewed ones
- [`real-bot-load-test.md`](./real-bot-load-test.md) — `/bulk_messages` through the real Telegram:
  its private chat limit, the pause, a reply behind bulk messages
- [`font-convertor.md`](./font-convertor.md) — font conversion, the domain
- [`user.md`](./user.md) — `User`, the snapshot of a Telegram profile
- [`logging.md`](./logging.md) — the `Logger` port, its adapters and request correlation
- [`i18n.md`](./i18n.md) — locales and Fluent bundles
- [`storage.md`](./storage.md) — PostgreSQL: `Database`, migrations, sessions
- [`config.md`](./config.md) — the configuration and its sources
- [`testing.md`](./testing.md) — tests and checks
- [`invariants.md`](./invariants.md) — the rules the compiler does not tie together: a
  violation compiles and breaks behaviour silently

## Overview

The purpose is converting fonts between formats (`src/font-convertor/`,
[`font-convertor.md`](./font-convertor.md); the domain — [`CONTEXT.md`](../../CONTEXT.md)).
Telegram is the delivery channel; `User`, sessions and migrations exist for the sake of the
Telegram front end.

Stack:

- **grammY** + `@grammyjs/conversations`. The updates come by long polling through the inbox
  ([`inbox.md`](./inbox.md)).
- **inversify** — DI, bindings by hand.
- **PostgreSQL** — the `postgres` client (porsager) at runtime, `node-pg-migrate` for migrations.
- **pino** in production, `console` in the other modes — behind the `Logger` interface.
- **FontForge** — an external CLI.
- **Fluent** (`@moebius/fluent`) — i18n, locales `ru` (the default) and `en`. The
  `@grammyjs/fluent` plugin is not used: the context is filled by our own middleware
  ([`i18n.md`](./i18n.md)).

`src/` is laid out by purpose, not by technical layers (the restructuring —
[#245](https://github.com/yuldashevsardor/telegram-bot/issues/245)). There are two modules:

- `font-convertor/` — the only domain one;
- `telegram/` — what exists for the sake of Telegram (above): the bot, `User`, the outbox of
  outgoing calls and the inbox of incoming updates beside it, with the command line
  that unblocks them.

Around them stand four directories named by role:

- `cli/` — what `npm run cli` runs: the contract of a command and the resolvers; the commands lie
  with their queue;
- `platform/` — adapters to the outside world that import no module;
- `bootstrap/` — the composition root. It knows every side at once, and that is its job;
- `shared/` — what everyone takes: the base error, cross-cutting types, the DI token dictionary,
  `configValue` and utilities.

An interface and its implementation are not split into layers, however many implementations there
are. The `Logger` interface and both adapters lie in `platform/logger/`; `UserRepository` and
`PgSqlUserRepository` lie in `telegram/user/` ([`storage.md`](./storage.md)). Such a pair can
still end up in different directories, but not by layer.

Errors: only `RuntimeError` (`shared/errors.ts`) goes outwards, or its subclass from a
`<module>.errors.ts` next to the throwing code. `<module>` is the file name prefix, not the
directory. The only subclass outside `*.errors.ts` is `InvalidConfigError`, which lies next to
the base.

An error that describes a contract rather than the business of one file may lie at the contract
instead of next to the throwing code:

- `InvalidLogLevel` (an invalid `Level`) is in `platform/logger/logger.errors.ts` and is thrown by
  `AbstractLogger`;
- `UpdateWithoutFrom` is in `telegram/bot/bot.errors.ts` and is thrown by
  `fill-user-to-context.middleware.ts`;
- `UserNotFound` is in `telegram/user/user.errors.ts`, at the entity, and is thrown by
  `PgSqlUserRepository.getById()`. "There is no such user" is the vocabulary of `User`, not the
  business of the adapter.

The constructor is `new RuntimeError(message, payloadOrCause)`. How it sorts an `Error` and a
payload, and why an `Error` in `payload.cause` moves to the standard `cause`, is in its comments
(`shared/errors.ts`).

The details are collected by static factories in place (`ExtensionNotSupport.byExtension()`). A
foreign error without details of its own is wrapped by `byError()`: it takes the error's message
and puts the error itself into `cause`. If a payload is needed as well, the error goes as the
`cause` field inside it (`UserService.create()`).

The bot commands are in [`bot.md`](./bot.md), "Commands". Two of them are test commands:
`/font_generator`, a debugging conversion of a fixed file, and `/bulk_messages`, a load tool, not a
feature, which runs only from its recipient chats. They are needed in development only and are
removed before going to production. The only requirement on such a command is not to reach
production. Production standards do not apply to them. These count as a property of a test
command, not a defect, and need no fixing:

- the tie to the developer's environment: the input font from a test fixture and hardcoded chat
  IDs;
- the absence of a permission check in `/font_generator`.

The relaxation does not cover the tests. As long as the command exists, its spec holds the
behaviour as it is, that tie included ([`testing.md`](./testing.md), "Mutation testing"). Nor does
it cover the ban on a direct `console.*` ([`logging.md`](./logging.md)): the linter holds it over
the whole repository.

## Directory map

```
src/
  app.ts                    entry point: new Application(), signals, fail()
  cli.ts                    entry point of `npm run cli`: the container without the bot, one command by the arguments (outbox.md)
  cli/                      what `npm run cli` runs: the CliCommand contract, the first-level resolver, the arguments helper, the base of the queue resolvers (telegram/); the commands lie with their queue (outbox.md)
  font-convertor/           font conversion (font-convertor.md)
  telegram/                 grammY: commands, conversations, middleware, filters, session, locales (bot.md, i18n.md); what the outbox and the inbox share: the retry delay (retry-delay/), the error classes of a failed Bot API call (bot-api-failure-classifier/), the Api factory, the jsonb string rule (outbox.md, inbox.md); the file a queued call sends, PathFile (path-file/, outbox.md); the list of formats the texts name (supported-formats.ts, bot.md)
    user/                   the entity, the repository interface, the service, the PostgreSQL adapter (user.md)
    inbox/                  the inbox of incoming updates in PostgreSQL: the store (push, claim, lease extension, completions, ready notifications, cleanup), the runner with its update source and the processor of one update over the bot, the timers of the lease recovery, the cleanup and the line of the blocked groups (maintenance/), the error classes and the outcomes of a failed handler, the release on stop, the polling source, the unblock of a group (command/) (inbox.md)
    outbox/                 the outbox of Bot API calls in PostgreSQL: the transformer that pushes the calls of the bot (transformer/), the store (push, pull, completions), the runner with its message source, the timers of the lease recovery, the cleanup, the status line and the line of the blocked chats (maintenance/), the lease recovery, retrier and release on stop (lease/), the processor of one message with the sender of its call, the outcomes of a failure, the result waiter with its reader, the payload codec, the commands that unblock a chat (command/) (outbox.md)
  platform/                 adapters that know no module
    database/               Database (storage.md)
    logger/                 the Logger interface, the Level enum, ConsoleLogger, PinoLogger (logging.md)
    request-context/        RequestContext: the scope and the values of a request (logging.md)
  bootstrap/                the composition root, knows every side
    application/            ApplicationContext and Application: assembly and lifecycle (application.md)
    container/              the inversify container (application.md)
    config/                 ConfigContainer, the shape of ConfigValues, the path types of get() and the CC alias (config.md)
      builder/              the ConfigBuilder interface and ConfigValuesBuilder: building and validating ConfigValues (config.md)
      parser/               ConfigParser: strict parsing of the strings of a source snapshot (config.md)
      storage/              ConfigStorage and WatchableConfigStorage, the watchability guard (config-storage.helper.ts), sources: env and file (config.md)
  shared/                   RuntimeError, cross-cutting types, the DI token dictionary, configValue (application.md);
                            NumberHelper, utils (sleep, withTimeout), time units (time.ts)
    fs/                     FileHelper
    process/                ProcessHelper — running external processes (invariants.md)
    string/                 StringHelper
test/                       mocha specs; a spec path repeats the source path, though not in full —
                            the rule is below;
                            the shared code of the specs is *.helper.ts next to the spec of its
                            source, and for the root hook — next to the hook; a helper that
                            stands for no source of its own and serves the specs of several
                            directories lies in their nearest common directory
                            (database.helper.ts, telegram/fake-bot-api.helper.ts);
                            the root holds the hooks of mocha, of make coverage and of Stryker,
                            and the wrapper of make mutation (testing.md)
  load/                     the outbox and inbox load tests: the fills, the churn of one chat and
                            the measurements of make load-*
                            (outbox-load-test.md, inbox-load-test.md)
  conversion/               the conversion check of make test-fonts: the fixtures over every pair,
                            the facts of the font before and after, the expected differences
                            (testing.md)
migrations/                 migrations, common/ holds the shared shorthands and the stub (storage.md)
scripts/                    host scripts of the make targets; claude-worktree-guard is a hook (testing.md)
  review/                   the Python actions of the review skills and the width check of make check,
                            each with its test_*.py next to it (testing.md)
    templates/              the texts mutation_batch.py posts to GitHub
```

File names are kebab-case (`CLAUDE.md`, "Style"). The modules of `scripts/review/` are the
exception: they use underscores (`tree_remove.py`). Python cannot import a module whose name has a
hyphen, and the specs import the module they check. The same holds for their specs: `unittest`
finds them by the `test_*.py` pattern and imports them as modules too.

A subsystem is a directory named in the map above. `convertor/`, `eot-packer/`, `font-forge/` and
the other directories inside subsystems are not in the map. A role directory is a subsystem whose
name is a role rather than the name of a file inside: `platform/`, `cli/`, `shared/fs/`.

A directory inside a subsystem is created on at least one of four grounds, otherwise it is not
created (`shared/` has a rule of its own, below):

- it hides;
- it gathers;
- it stands around one sibling;
- it keeps a main file with its companions.

Only "hides" declares a visibility boundary. A directory everything is imported from declares no
boundary and only makes the import path longer. The other three grounds need no visibility
boundary:

- "Gathers" declares the boundary of a contract: from `telegram/command/` both the base class and
  every sibling are taken outwards.
- A directory with companions keeps them at the main file whether they are visible outside or not.
  From `telegram/bot/` `bot`, `bot.types` and `bot.errors` are imported, from `font-forge/` only
  `font-forge`.
- A directory around a sibling separates from the other siblings the one that has files or a role
  of its own.

The companions ground is in the rule so that the place of a companion does not depend on which
half of the tree its main file lies in: in `shared/` the companions always went off into a
directory.

**Hides** — exactly one of its files is imported from outside, and the other files of the
directory are its internals: `eot-packer/eot-packer.ts`, `font-forge/font-forge.ts`,
`convertor/convertor-factory.ts`. The directory name is the prefix of that file's name, so that
the import path can be guessed from the class name.

**Gathers** — same-kind siblings of one contract, enumerated by one registrar:

- `convertor/<from>/` — by `convertor-factory.ts`;
- `validator/` — by `font-validator-resolver.ts`;
- `command/`, `filter/` and `middleware/` — by `Bot` (`telegram/bot/bot.ts`). `conversation/`
  is one such directory with no sibling left: it keeps only the base class,
  `conversation-handler.ts`, for the next conversation, while the plugin stays installed with an
  empty list ([`bot.md`](./bot.md), step 6);
- `outbox/command/` and `inbox/command/` — by `OutboxCommandResolver` and `InboxCommandResolver`,
  which lie with their commands;
- the `.ftl` bundles in the `locale/` directories at commands and middleware — by the walk in
  `createFluent()` (`telegram/locale/locale.ts`).

The walk looks for files by extension (`FileHelper.findFilesByExtensions()`), not by directory
name. So it does not confuse the bundle directories with the namesake `telegram/locale/`, which
holds `locale.ts` itself with its companions and not a single `.ftl`.

The base class of the contract lies with the siblings (`command/command.ts`,
`conversation/conversation-handler.ts`, `filter/filter.ts`, `middleware/middleware.ts`,
`validator/font-validator.ts`), in the parent (`convertor/convertor.ts`) or, as the `CliCommand`
interface of the commands of the queues, in the module that runs them (`cli/cli-command.ts`). A
siblings directory is named after their contract (`command/` at `command.ts`) or after a feature
the siblings share (`convertor/eot/` — the source format).

**Stands around one sibling** — a sibling leaves the siblings directory for a directory of its
own only when it has files of its own or a role of its own among the siblings:

- `command/start/`, `command/help/`, `command/bulk-messages/`, `command/font-generator/` and
  `middleware/not-a-file/` keep the command or the middleware together with their `locale/`
  bundles;
- `validator/svg/` keeps `SvgFontValidator` together with its companions, its path data parser,
  the range check of the points of an outline and the text codec it shares with `SvgFontPreparer`,
  `validator/woff2/` keeps `Woff2FontValidator` together with its companions and its glyf
  reconstructor, `validator/woff/`, `validator/eot/` and `validator/sfnt/` keep
  `WoffFontValidator`, `EotFontValidator` and `SfntFontValidator` with their companions.

A sibling with neither lies flat in the siblings directory: `filter/has-session-key.filter.ts`,
`middleware/request-log.middleware.ts`. The name is the prefix of the sibling's file name
(`start/` at `start.command.ts`) or the role.

**Keeps a main file with its companions** — `*.types.ts` and `*.errors.ts` lie in the directory
together with their main file, and the directory name is the name of the main file:
`eot-header/eot-header.ts` with its `*.types.ts` and `*.errors.ts`. Companions lie the same way in
the directories the map names itself: `font-convertor/font-convertor.*`, `platform/logger/logger.*`,
`telegram/user/user.*`. The directory name there is the name of the main file as well. A directory
with companions can also stand inside a hiding one: `eot-packer/sfnt-reader/` keeps `sfnt-reader.ts`
with its `*.types.ts`, while from outside `eot-packer/` still only `eot-packer.ts` is visible.

A directory name does not repeat words the path above it has already said. They are struck out of
the name the ground gives: `bootstrap/config/container/` at `config-container.ts`,
`bootstrap/config/storage/file/` at `config-file-storage.ts`, `telegram/user/pgsql-repository/`
at `pgsql-user-repository.ts`. Files inside do not shorten their names: a file is still named
after its class. Striking out does not cut proper names: `font-forge/` is named after the
FontForge program.

A directory whose name meets the rule is the end point of its main file: the file does not move
deeper. So when the path has already named every word, the directory name is the last word of the
main file's name. That holds only when the directory where the main file would lie without the new
one does not meet the rule:

- `convertor/` in `font-convertor/` would be left without a name without the last word;
- `config-storage.ts`, should it get companions, stays right in `storage/`: `storage/storage/`,
  like `telegram/user/user/`, would be an extra level.

A command prints the main files with companions whose directory does not meet the rule. For each
one it computes the directory name from the path above by the rule and compares it with the real
one. Then it checks the directory one level up the same way: if that one meets the rule too, the
main file's directory is an extra one. So the command catches:

- a main file with companions outside its directory (left flat in `telegram/`);
- a word the path has already said;
- a word absent from the main file's name;
- an extra level.

The output leaves out the role directories (`cli/` and any directory in `shared/`: their names are
their own) and `font-forge/`. The tree meets the rule in full, and the output is empty. The command
does not check hiding directories without companions.

```bash
find src -name '*.types.ts' -o -name '*.errors.ts' | while read -r f; do m="${f%.*.ts}"; \
    [ -f "$m.ts" ] || continue; d="${f%/*}"; words="$(basename "$m" | tr '.-' '\n\n')"; \
    fit="$(for x in "$d" "${d%/*}"; do up=" $(echo "${x%/*}" | tr '/-' '  ') "; \
    want="$(echo "$words" | while read -r w; do echo "$up" | grep -q " $w " || echo "$w"; done \
    | paste -s -d - -)"; [ "$(basename "$x")" = "${want:-$(echo "$words" | tail -1)}" ] \
    && echo 1 || echo 0; done | tr -d '\n')"; [ "$fit" = 10 ] || echo "$m.ts"; done \
    | grep -vE '^src/(cli|shared/[^/]+|font-convertor/font-forge)/' | sort -u
```

Otherwise files lie flat: the parts of a subsystem are grouped by the file name prefix. A file
without companions does not get a directory (`font-convertor/sfnt-version.ts`).

Two directories lack the grounds. In each, none of the files hides the others, and there are no
siblings of one contract among them:

- `telegram/session/` holds three files of different roles (`pgsql-storage.ts`,
  `session.helper.ts`, `session.types.ts`). The directory name matches the prefix of
  `session.helper.ts` and `session.types.ts`, but the directory keeps no main file with
  companions: there is no `session.ts` in it, and `session.types.ts` stands without its main file.
- `telegram/outbox/lease/` holds the three classes of the lease (`outbox-lease-recovery.ts`,
  `outbox-lease-retrier.ts`, `outbox-lease-releaser.ts`). The directory name is their common
  prefix with `outbox` struck out, and none of them is a main file with companions.

In `shared/` one deliberate divergence from the rule remains, the directory name: it is named by
role (`fs/`, `process/`, `string/`), not after the main file. A single-file utility lies flat in
the root (`number-helper.ts`, `utils.ts`). The root `errors.ts` and `types.ts` are standalone
files, not companions, and take nobody off into a directory.

A command counts which files of a directory are visible from outside. `<path>` is from `src/`. The
command does not apply to a `locale/` bundle directory: `.ftl` is not imported through the alias.

```bash
grep -rHoE "app/<path>/[A-Za-z0-9._-]+" src --include='*.ts' | grep -v "^src/<path>/" \
    | sed "s#.*app/<path>/##" | sort -u
```

A spec path repeats the source path with one exception. A directory inside a subsystem named after
its main file is not reflected in the spec path: named by the file's name or its prefix,
struck-out words of the path included. A siblings directory and a directory around a sibling are
exceptions to this, see the paragraph on them below. Examples:

- the files of `convertor/`, `eot-packer/` and `font-forge/` are checked by specs right in
  `test/font-convertor/`;
- `telegram/bot/bot.ts` — by `test/telegram/bot.spec.ts`;
- `bootstrap/config/container/config-container.ts` — by
  `test/bootstrap/config/config-container.spec.ts`.

The directory of a subsystem itself is reflected even when it is built the same way.
`platform/request-context/` keeps a main file with a companion, and its spec lies in
`test/platform/request-context/`. The same goes for `platform/logger/`, `platform/database/` and
`telegram/user/`. Of the subdirectories of `bootstrap/config/` it goes for `builder/`, `parser/`
and `storage/`, which the map names. A directory named by a role rather than after its main file
does not fall under the rule, no reservation needed: `fs/` at `file-helper.ts`.

A siblings directory and a directory around a sibling fall out of the rule, but on different
conditions:

- A directory around a sibling is always reflected, even when it hides its `locale/` bundles.
  `telegram/command/start/` (named after `start.command.ts`) and `telegram/middleware/not-a-file/`
  stand in the spec path in full.
- A siblings directory is reflected only when it does not hide: "hides" takes precedence.
  `command/` (named after `command.ts`), `filter/` and `middleware/` give outwards both the base
  class and the siblings, and are reflected; `conversation/`, with its base class alone, too.
  `convertor/` keeps the `<from>/` siblings directories, but from outside only
  `convertor-factory.ts` is imported from it, so it is not reflected.

A siblings directory inside a non-reflected one is reflected without it: a spec of
`convertor/eot/eot-to-ttf.ts` would go into `test/font-convertor/eot/`. The pairs have no specs
now.

A spec on the database of a source that has a spec with fakes as well is
`<source>.database.spec.ts` next to it, as `outbox-runner.database.spec.ts`.

A command prints the divergences: every spec whose path repeats the path of no source with the
same name. The only deliberate exceptions among them are specs whose path is shorter than the
source path by non-reflected directories. A spec deeper than its source or in another branch of
the tree is printed all the same and breaks the rule. The command does not show a spec put inside
a non-reflected directory: its path matches the source path, and the rule is broken silently.

```bash
find test -name '*.spec.ts' | while read -r s; do base=$(basename "$s" .spec.ts); \
    base=${base%.database}; srcs=$(find src -name "$base.ts"); [ -z "$srcs" ] && continue; \
    echo "$srcs" | grep -q "^src$(dirname "$s" | sed 's#^test##')/$base\.ts$" \
    || echo "$s | $(echo "$srcs" | tr '\n' ' ')"; done
```

Imports go only through the `app/*` alias (`tsconfig.json` + `tsc-alias`). The ESLint rule
`no-restricted-imports` forbids relative ones. The specs import the shared code from `test/`
through a second alias, `test/*`. It is declared only in `tsconfig.check.json` and is absent from
the build; the comment right there says why and what that threatens. The exception is the
`migrations/` directory: it lies outside `src/`, and the alias does not lead there. The rule is off
for the whole directory through `overrides` in `.eslintrc.js`.

The linter does not check the independence of the domain (`CLAUDE.md`, "Style").
`font-convertor/` imports neither `platform/` nor `bootstrap/` directly, but the independence is
not complete. `shared/config-value.ts` takes the configuration from `ApplicationContext`
([`application.md`](./application.md)). So `shared/` has one runtime dependency on the
composition root, and the domain reaches `pino` through it.
