# Architecture

This document describes the system **as it currently exists in the code**, including rough edges, dead code, and unfinished features. It is not a description of an idealized target design. Where something is ambiguous or couldn't be confirmed from the code alone, it's called out explicitly in [Open questions](#18-open-questions--uncertainties) rather than guessed at.

No `README.md` content exists to cross-check against (it currently contains only a title), so everything here is derived from source, git history, and config files as of commit `ca8b1c2`.

**Revision note:** this document has been through a second, deeper verification pass focused on runtime behavior (exact Promise semantics, exact grammY framework internals at the locked version `1.10.1`, exact middleware execution order and failure modes). That pass is written up in full, flow-by-flow, in [`docs/flows.md`](./flows.md) — read it for the precise trigger → sequence → branching → state-change → error-handling trace of every major flow. This document has been updated in place wherever that deeper pass found the original (structural) description to be incomplete or wrong; those corrections are marked **(corrected)** inline below.

## 1. Overview

**The core purpose of this system is font-format conservation** — converting and preserving font files across as many formats as possible (`src/domain/font-convertor/`, §7). Telegram is a delivery frontend for that capability, not the point of the project; `User`, `BulkMessagesCommand`, and the Postgres migrations exist because a Telegram frontend needs them, not as independent features. Read the rest of this document with that priority in mind — the font-conversion domain is the part worth investing in; the bot/DI/logging/config scaffolding around it is infrastructure in service of getting fonts in and out via Telegram.

Built on **grammY**, wired together with **inversify** dependency injection, backed by **PostgreSQL**. `/start` is the entry conversation; `/font_generator` exercises the font-conversion domain (currently non-functional as wired — see §7/§17); `/bulk_messages` is a manual load-testing tool for exercising the Telegram-rate-limiting pipeline by hand, not a user-facing feature (see [§17](#17-known-issues--fragile-areas)).

Stack:
- **grammY** (`grammy`) — Telegram Bot API framework, run via `@grammyjs/runner` (long-polling, concurrent update processing) with `@grammyjs/conversations` for multi-step flows.
- **inversify** — DI container, manually wired (no decorator auto-discovery).
- **PostgreSQL** — via the `postgres` (porsager) client at runtime, and `node-pg-migrate` (which pulls in `pg`) for schema migrations.
- **pino** / plain `console` — two logger backends behind a domain `Logger` interface.
- **FontForge** (external CLI, shelled out to) — font format conversion.
- **Fluent** (`@moebius/fluent` + `@grammyjs/fluent`) — i18n, Russian only in practice today.

The code is organized in a loose hexagonal/clean-architecture style: `domain/` holds business logic and ports (interfaces), `infrastructure/` holds adapters (Postgres, grammY, loggers, config), and `common/` holds cross-cutting types/errors. This layering is fairly consistently applied for `user` and `logger`, less so elsewhere (e.g. `broker`/`planner`/`slot-manager` are pure domain logic with no separate port, since they have no external system to abstract away).

## 2. Entry point & bootstrap

`src/app.ts` is the sole entry point:

```
import "reflect-metadata"        // required for inversify's decorator metadata
await container.setup()          // wires all DI bindings (see §4)
bot = container.get<Bot>(...)
await bot.run()
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
bootstrap().catch(console.error)
```

`stop()` calls `bot.stop()` (see §5 for what that entails) then `container.close()`.

Notable gaps:
- `bootstrap().catch(console.error)` only logs a failed bootstrap — it never calls `process.exit(1)`, so a bootstrap failure (e.g. bad `BOT_TOKEN`, DB unreachable) can leave a Node process alive but doing nothing.
- `Container.close()` (`src/infrastructure/container/container.ts`) is a stub — it only flips its internal `alreadySetup` flag if already set up and does nothing else. The Postgres connection pool (`Database.sql`) is never explicitly closed on shutdown.
- `package.json#main` points at `./build/src/index.js`, but the actual compiled entry used by `npm start` is `build/app.js` — these are inconsistent (there is no `src/index.ts`).

## 3. Directory map

```
src/
  app.ts                    entry point
  common/                   cross-cutting types & base error class
  domain/                   business logic + ports (framework-agnostic)
    broker/                 outbound message dispatch worker (§6)
    planner/                priority queue + rate-limit gate (§6)
    slot-manager/           single-slot cooldown primitive (§6)
    font-convertor/         font format conversion (§7)
    user/                   user entity/repository-interface/service (§8)
    logger/                 Logger interface + Level enum (§9)
  helper/                   generic utilities (string/number/file/sleep)
  infrastructure/           adapters (concrete implementations)
    bot/                    grammY wiring: commands, conversations, middleware, filters, session (§5)
    config/                 env loading (§12)
    container/              inversify DI wiring (§4)
    database/               Postgres connection + migrations (§11)
    logger/                 Console/Pino logger implementations (§9)
    repository/             Postgres repository implementations (§11)
    async-local-storage.ts  shared AsyncLocalStorage instance (§9)
docker/pgsql/                docker-entrypoint init script for local Postgres
test/                        the (mostly empty) test suite (§14)
```

All internal imports use the `app/*` path alias (mapped to `./src/*` in `tsconfig.json`, resolved at build time via `tsc-alias`), never relative paths — ESLint's `no-restricted-imports` rule bans relative import patterns entirely, so `app/...` is the only way code is allowed to reference other modules. Migration files locally disable that rule since `node-pg-migrate` needs conventional imports.

## 4. Dependency injection

`src/infrastructure/container/container.ts` defines `Container extends InversifyContainer` with an idempotent `setup()`:

```
setup()
 └─ setupModules()        Planner, Broker (singleton) → setupBot()
     └─ setupBot()        Bot, filters, middlewares, commands, session storage, conversations
 └─ setupServices()       font-convertor stack, user stack (all singleton)
 └─ setupInfrastructure() Config, Database (singleton) → setupInfrastructureLogger()
```

Bindings use `Symbol.for(...)`-based symbols grouped into `Infrastructure` / `Modules` / `Services` namespaces (`src/infrastructure/container/symbols/`) — a manually maintained registry, not decorator-based auto-discovery. **Adding a new command, middleware, or service requires manually registering it in `container.ts`** — there's nothing that will fail loudly if you forget.

The one non-obvious piece of wiring is `setupInfrastructureLogger()`:
1. Binds `ConsoleLogger` and `PinoLogger` as concrete singletons, both configured with `config.logger.levels`.
2. **Rebinds** `PinoLogger`'s symbol to a `Proxy`: every property access first checks `asyncLocalStorage.getStore()?.get("logger")` and uses that instead if present, falling back to the singleton otherwise. This is how per-request child loggers (tagged with a `requestId`, see §9) get transparently substituted without any consumer code knowing about it.
3. Resolves `config.logger.default` (env `LOGGER_DEFAULT`, `ConsoleLogger` or `PinoLogger`) and binds *that* resolved instance as the single generic `Infrastructure.Logger` — this is the only symbol actually injected via `@inject<Logger>(Infrastructure.Logger)` everywhere else in the codebase.

Separately from constructor injection, two lazy property decorators pull values straight from the module-level `container` singleton at first property access, bypassing constructor injection (a service-locator pattern):
- `@ConfigValue<T>(key, defaultValue?)` (`src/infrastructure/config/config-value.decorator.ts`) — dotted-path lookup into `Config` (e.g. `"bot.token"`), throws if unresolved with no default. Used by `Bot`, `Database`, `Broker`, `Planner`, `FontGeneratorCommand`, etc.
- `@PgSql()` (`src/infrastructure/database/pgsql.decorator.ts`) — pulls `Database.sql` the same way. Used by `PgSqlUserRepository`, `PgsqlStorage`.

## 5. Bot layer

`src/infrastructure/bot/bot.ts` — `Bot` wraps a grammY `TelegramBot<Context>`. The `Context` type (`bot.types.ts`) composes `GrammyContext & SessionFlavor<SessionPayload> & ConversationFlavor & FluentContextFlavor & { user: User }`.

`Bot.run()`: `broker.run()` (starts the outbound queue worker, §6) → `setup()` → `grammy.catch(handleError)` → `run(this.grammy)` from `@grammyjs/runner` (a long-polling runner that processes updates concurrently, **not** grammY's built-in `bot.start()`).

`setup()` wires the pipeline in this exact order — this order matters and is the closest thing this repo has to a request-handling architecture diagram:

1. **`setupSession()`** — grammY `session()` middleware. Session key is `` `${ctx.from.id}:${ctx.chat.id}` `` (per user+chat pair). Storage backend is `PgsqlStorage` (Postgres-backed, §11). Payload (`SessionPayload`) is currently just `{ requestCount: number }`.
2. **`setupSequential()`** — `sequentialize()` from `@grammyjs/runner`, keyed by `[chat.id, from.id]`. Required because the runner processes updates concurrently; this serializes updates that touch the same chat/user to avoid race conditions on session state.
3. **`setupMiddlewares()`** — a `Composer` chaining, in order: `TelegramCallApiMiddleware` → `AsyncLocalStorageMiddleware` → `ResponseTimeMiddleware` → `RequestLogMiddleware` → `FillUserToContextMiddleware`.
4. **`setupFlavor()`** — Fluent i18n (see §10).
5. **`setupFilters()`** — `IsPrivateChatFilter` restricts everything registered after this point to private chats (`ctx.chat?.type === "private"`).
6. **`setupConversations()`** — `grammy.use(conversations())`, then registers every bound `Modules.Bot.Conversations` symbol (currently just `StartConversation`) via `createConversation(...)`.
7. **`setupCommands()`** — resolves every bound `Modules.Bot.Command` symbol (`StartCommand`, `BulkMessagesCommand`, `FontGeneratorCommand`), calls `command.setup(composer)` on each (registers `bot.command(name, handler)`), then calls `grammy.api.setMyCommands(commands)` — **a live network call to Telegram on every process startup** — before finally mounting the composer.

`Command`/`Filter`/`Middleware`/`ConversationHandler` are all thin abstract base classes following the same template-method shape: an abstract `handle`/`run` plus a `setup(composer)` that wires the instance into grammY.

`Bot.stop()`: stops the runner, then calls `waitPlannerToEmpty()` — an unbounded `while(true)` loop polling `planner.isEmpty()` every 3 seconds with **no timeout** — before stopping the broker. If the outbound queue never drains (e.g. an active Telegram rate-limit ban), shutdown can hang indefinitely.

### `TelegramCallApiMiddleware`

The most unusual middleware (`src/infrastructure/bot/middleware/mutation/telegram-call-api.middleware.ts`): it monkey-patches `ctx.api.raw` with a JS `Proxy`. Every outgoing Telegram API call carrying a `chat_id` — except a small whitelist of group-safe methods (`TELEGRAM_NO_GROUP_RATE_LIMIT_SET`, e.g. `getChat`, `sendChatAction`) applied **only to group chats** (private-chat calls are never exempt, even for these same read-only methods) — is intercepted, wrapped in a manually-resolved `Promise`, and pushed onto the `Planner` queue instead of being sent immediately. This is the entry point into the rate-limiting pipeline described in §6.

**(corrected)** This only wraps `ctx.api` — and, per grammY's own source (verified at the locked version `1.10.1`), **every incoming update gets a brand-new `Api` instance** (`ctx.api` is never the same object as `bot.grammy.api`, and no two updates share one). So this wrapping never accumulates across updates, but it also means it has zero effect on any code that calls through `bot.grammy.api` directly instead of `ctx.api` — `BulkMessagesCommand` and dead code in `StartCommand` do exactly that, and have to manually replicate the `planner.push(...)` call themselves as a result (see `docs/flows.md` Flow 4 for the full trace). A non-plain-object payload (e.g. a multipart file-upload payload) also bypasses the queue entirely, since the interception only recognizes plain `Object`-typed, `chat_id`-bearing payloads — not exercised by any live path today, but a real coverage gap. There's also an unused, dead constant in this file, `WEBHOOK_REPLY_METHOD_ALLOW_SET`, declared but never referenced anywhere.

### Session storage

`src/infrastructure/bot/session/pgsql.storage.ts` — `PgsqlStorage implements StorageAdapter<SessionPayload>`, backed by Postgres via `@PgSql()`. Reads/writes the `sessions` table directly (no repository abstraction, unlike `users` — see §11).

## 6. Outbound rate-limiting pipeline (Broker / Planner / SlotManager)

This is the most architecturally distinctive part of the codebase. Despite the name, `Broker` is **not** a general pub-sub message broker — the whole subsystem exists to throttle *outgoing* Telegram API calls so the bot doesn't get rate-limited or banned by Telegram.

**Flow:**

```
ctx.api.* call with chat_id
   │  (TelegramCallApiMiddleware Proxy on ctx.api.raw)
   ▼
Planner.push(message, priority)     3 FIFO buckets: HIGH / MEDIUM / LOW
   │
   ▼  (Broker's setTimeout-driven poll loop calls Planner.pull())
Planner.pull()
   │  1. null if globally banned or all queues empty
   │  2. null if the shared "common" SlotManager isn't free
   │  3. scan HIGH → MEDIUM → LOW; within a bucket, scan front-to-back
   │     for the first message whose per-chat SlotManager is free
   │  4. reserve both the common slot and the per-chat slot, return it
   ▼
Broker executes message.callback() (the original, un-proxied API call)
   │
   ├─ success → resolves the caller's original Promise
   └─ failure → planner.push(message, priorityOnError) to requeue;
                if HTTP 429, planner.ban(retry_after) (global ban)
```

- **`Planner`** (`src/domain/planner/planner.ts`) holds the three priority buckets and, per chat, a lazily-created `SlotManager` keyed by `chatId` (`limits.group` or `limits.private` depending on `message.isGroup`), plus one shared `commonManager` (`limits.common`). Because it scans for the first *eligible* message rather than strictly the head of the queue, delivery order isn't strict FIFO — a rate-limited chat's message can be skipped over in favor of a later message to a different chat. **`Planner.managers` is a `Map` that is never evicted from** — every distinct chat ID the bot has ever talked to leaves a `SlotManager` instance in memory for the life of the process (unbounded growth for a long-running bot with many users).
- **`SlotManager`** (`src/domain/slot-manager/slot-manager.ts`) is a minimal single-slot cooldown gate, not a token bucket: `reserveDuration = interval / number` (evenly spaced), `isFree()` checks whether that cooldown has elapsed, `reserve()` throws if called while not free. It's plain-constructed (`new SlotManager(limit)`), not DI-managed.
- **`Broker`** (`src/domain/broker/broker.ts`) self-schedules via `setTimeout` (not a real consumer/subscriber): pulls a message from `Planner`, sleeps `settings.sleepInterval` if none available, otherwise executes it. `Broker.run()`/`.stop()` are declared synchronous (`void`-returning) but are called with `await` in `Bot` — harmless but misleading. Idle poll interval (`BROKER_SLEEP_INTERVAL`) defaults to 1000ms in code but is overridden to **10ms** in the committed `.env.dist`.

Configured limits (`.env.dist`, deliberately mirroring Telegram's official Bot API rate-limit guidance):

| Scope   | Number | Interval  |
|---------|--------|-----------|
| common  | 30     | 1000 ms   |
| private | 3      | 1000 ms   |
| group   | 20     | 60000 ms  |

`broker.errors.ts` and `planner.errors.ts` both exist but are empty — every sibling domain module defines its own `RuntimeError` subclasses, these two don't, suggesting unfinished error handling here.

**(corrected — significant) The retry-on-failure and ban-on-429 logic is very likely dead code at runtime.** Tracing the exact Promise chain (full detail in `docs/flows.md` Flow 4): the `callback` closure built in `TelegramCallApiMiddleware` calls the real, un-proxied `originRaw[method](payload, signal)` **without awaiting it** — it just hands the resulting (pending) Promise to `messageResolve(...)`. Because Promise-resolving-with-a-Promise adopts the inner Promise's *eventual* state, the original caller (e.g. whatever awaited `ctx.reply(...)`) does correctly see a rejection if the real Telegram call fails — but `callback()` itself, having no `await` in its body, resolves immediately regardless of what the real call does later. `Broker.handleMessage`'s `try { await message.callback(); } catch (error) { ...requeue, ban-on-429... }` therefore essentially never observes a failure — its `catch` block would only fire on a *synchronous* throw from invoking `originRaw[method]`, which normal Telegram API failures (429s included) don't produce (they're async rejections). **Net effect: a message that fails is not requeued, and `Planner.ban()` on HTTP 429 is not actually reached in practice** — the code visibly implements backoff/retry, but the mechanism connecting it to real failures is broken. This was not visible from a structural read of the code; it required tracing exact `async`/`Promise.resolve(thenable)` semantics. Also not caught structurally: `Broker.handleMessages()`'s recursive branch (when a message *is* available) does not wait for the real network call to finish before immediately pulling the next one, for the same underlying reason — this happens to give reasonable throughput, but is a side effect of the same bug, not a deliberate design.

## 7. Font conversion

`src/domain/font-convertor/` converts font files between formats (WOFF, WOFF2, OTF, TTF, EOT) for the `/font_generator` command.

```
FontConvertor.convert(params)
  → derives origin extension, throws if source === target extension
  → generates a random filename in a date-bucketed temp dir
    (FileHelper.createDirectoriesByDate: tempDir/YYYY/M/D)
  → ConvertorFactory.get(from, to)   — dispatch table over ~20 concrete
                                        pair classes (WoffToEot, EotToOtf, ...),
                                        one file per pair under convertor/{ext}/
  → concrete Convertor.validate()    — extension + MIME-type allow-list
                                        (MIME derived from extension via the
                                        `mime-types` package, not content sniffing)
  → FontForge.convert(src, dist)     — shells out to the `fontforge` CLI:
      fontforge -c 'import fontforge; font = fontforge.open("{SRC}");
                     font.generate("{DIST}")'
```

The `fontforge` command string is built with naive `.replace()` templating — there's **no shell-escaping** of the paths. Current risk is low because paths are internally generated random strings, but this would be a command-injection vector if a path ever became user-influenced.

`SVG` is declared as a supported extension (`FontForge.supportedExtensions`) but has **no conversion pairs registered** in `ConvertorFactory` — any SVG conversion throws `ConvertorNotFound`. `convertor.ts` (lines ~58–61) has a commented-out block for content-based MIME sniffing via `FileHelper.getMimeType()` (which shells out to `file --mime-type -b`) — this is the dead link to what `mmmagic` was presumably meant to provide; `mmmagic` itself has zero usage anywhere in `src/` (see §13).

**(corrected)** The date-bucketed temp directory (`FileHelper.createDirectoriesByDate`, `src/helper/file-helper/file-helper.ts`) builds its path as `tempDir/<year>/<month 1-12>/<X>`, where `<X>` comes from `dayjs().day()` — **that's day-of-week (0–6, Sunday=0), not day-of-month** (`.date()` would be the correct call for that). So the deepest directory only ever takes 7 distinct values and cycles weekly rather than giving each calendar day its own bucket, despite the `YYYY/M/D`-shaped structure implying otherwise.

**(corrected)** The generated font file is **never actually sent to the user.** `FontConvertor.convert(...)` returns a local server-side filesystem path, and both places that call it (`FontGeneratorCommand.generateRandomFonts`, and the identical dead-code pattern in `StartCommand.generateRandomFonts`) do `await ctx.reply(eotPath)` — replying with the **path string as text**, not uploading the file. Additionally, `FontGeneratorCommand.handle()`'s bug (see §17: `promises.push(this.generateRandomFonts.bind(this, ctx))` pushes a bound function reference rather than calling it) means `/font_generator` currently does **nothing observable at all** when invoked — no reply, no conversion, no error, just silence. Full trace in `docs/flows.md` Flow 6.

## 8. User domain

`src/domain/user/` follows a small DDD-lite pattern: entity + DTOs + repository interface (port) + application service, implemented against Postgres in the infrastructure layer.

- **`User`** (`user.ts`) — entity with true JS-private `#fields` (id, firstname, lastname, username, isBot, lastActiveTime, createdTime, updatedTime). Every setter calls a private `toggleUpdatedTime()`, auto-stamping `updatedTime` — an invariant enforced at the entity level.
- **`UserRepository`** (`user.repository.ts`) — pure interface: `getById`, `existsById`, `save` (upsert), `delete`.
- **`UserService`** (`user.service.ts`) — `create(dto)` and `edit(id, dto)` (partial update, only applies defined fields), wraps failures as `UserCreateError`/`UserEditError`. `create()` doesn't itself guard against duplicates — it relies on the caller having already checked `existsById` *and* on the repository's `save()` being an upsert, splitting one invariant across two layers.
- **`PgSqlUserRepository`** (`src/infrastructure/repository/pgsql.user.repository.ts`) implements the port: `insert ... on conflict (id) do update set ...` via the `postgres` tagged-template client. Private `rowToEntity`/`entityToRow` mappers convert between the domain shape and the snake_case DB row.

Driven by **`FillUserToContextMiddleware`** on every incoming update: checks `existsById`, then `create` or `edit`, stamping `lastActiveTime = dayjs()` (this is the "last active" tracking mechanism). If `ctx.from` is missing (e.g. channel posts), it logs an error and returns **without calling `next()`**.

**(corrected)** That guard is actually **unreachable dead code** in practice. It runs *after* `RequestLogMiddleware` in the pipeline (§5), and `RequestLogMiddleware`'s first statement, `context.session.requestCount++`, throws synchronously for exactly the same class of update — any update missing `ctx.from` also fails grammY's session-key resolution (`getSessionKey` requires `ctx.from`), and accessing `ctx.session` when the key resolution failed throws (verified against grammY `1.10.1` source). So the pipeline crashes at `RequestLogMiddleware`, one middleware before `FillUserToContextMiddleware`'s own explicit check would ever run, for every real case that check was written to handle. The actual "drop mechanism" for such updates is this unhandled exception surfacing as a `critical` log via `Bot.handleError`, not the explicit guard. Full trace in `docs/flows.md` Flow 3.

Also newly noted: **`RequestLogMiddleware`** (`src/infrastructure/bot/middleware/request-log.middleware.ts`) increments `context.session.requestCount` and logs the **entire raw `ctx.update` object** (including message text and sender info) at `debug` level on every update that reaches it — this is the only place `SessionPayload.requestCount` is read or written anywhere in the codebase (tracked but never surfaced), and the full-payload debug logging is worth knowing about if debug-level logs are ever shipped somewhere less trusted than local disk.

`UserAlreadyExists` (`user.errors.ts`) is defined but never thrown anywhere — dead, since `save()` upserts instead of erroring on conflict.

## 9. Logging

Clean port/adapter split:
- **`src/domain/logger/logger.ts`** — the `Logger` interface (`critical/error/warning/info/debug(message, payload?)`), the port domain code depends on. `logger.types.ts` defines the `Level` enum (`CRITICAL/ERROR/WARNING/INFO/DEBUG`).
- **`src/infrastructure/logger/`** — adapters: `AbstractLogger` (shared level-filtering via `setLevels`), `ConsoleLogger` (formats `[timestamp] [LEVEL] message payload`, serializes `Error` payloads via `serialize-error`), `PinoLogger` (wraps `pino` with custom numeric levels matching the domain `Level` enum, `useOnlyCustomLevels: true`, has a `child(context)` method).

Which concrete adapter is actually injected as `Infrastructure.Logger` is resolved once in `Container.setupInfrastructureLogger()` (§4) based on `config.logger.default` (env `LOGGER_DEFAULT`; defaults to `PinoLogger` in production, `ConsoleLogger` otherwise).

**Request correlation:** `src/infrastructure/async-local-storage.ts` exports one shared `AsyncLocalStorage<Map<string, any>>`. `AsyncLocalStorageMiddleware` (first in the middleware chain after the API-proxy middleware) runs `asyncLocalStorage.run(new Map([["logger", childLogger]]), next)` per update, where `childLogger` is a `PinoLogger.child()` tagged with a `requestId` (uuid v4). Because `PinoLogger`'s DI binding is a `Proxy` that reads `asyncLocalStorage.getStore()?.get("logger")` on every property access (§4), any code injecting `Infrastructure.Logger` automatically gets this request-scoped, correlated logger for free — *but only when `PinoLogger` is the active default*. The middleware itself is guarded by `if (!(logger instanceof PinoLogger)) return next();`, so **in development (where `ConsoleLogger` is the default), this middleware effectively no-ops and there is no request correlation**.

One naming collision worth knowing about: `src/infrastructure/config/config.ts` locally declares its own `type Logger = { default: symbol; levels: Level[] }` — same name as the domain `Logger` interface, unrelated shape (it's the *configuration for choosing* a logger, not the logger contract). File-scoped, so harmless, but confusing to grep for.

## 10. i18n (Fluent)

`Bot.setupFlavor()` (`bot.ts`) recursively globs all `.ftl` files under `src/infrastructure/bot` (`FileHelper.findFilesByExtensions`), derives each file's locale from its filename by convention — `*.locale.<lang>.ftl` (e.g. `start.conversation.locale.ru.ftl` → `ru`), not from directory structure — groups files by locale, and registers each group with a `@moebius/fluent` `Fluent()` instance. Wired into grammY via `@grammyjs/fluent`'s `useFluent()`.

Only **one** `.ftl` file exists in the whole repo (Russian, one key: `welcome`). **`localeNegotiator` is hardcoded to always return `"ru"`** — so despite the file-based multi-locale-capable plumbing, the bot can only actually serve Russian today, regardless of a user's Telegram client language. `StartConversation.run()` also has a hardcoded Russian fallback string ("Чет не получилось...") on the line after its `ctx.t("welcome", ...)` call, bypassing Fluent entirely for that path — inconsistent use of the i18n system even within its one consumer.

This is genuinely new/in-progress: the most recent commit, `ca8b1c2` ("Implement support i18n (Flover)"), added the Fluent dependencies, the one `.ftl` file, the `setupFlavor()` logic, and reorganized command/conversation files into per-command subdirectories so each conversation's locale files sit next to its handler.

## 11. Data storage

**Runtime client:** `Database` (`src/infrastructure/database/database.ts`) wraps the **`postgres`** npm package (porsager, tagged-template SQL, no ORM), constructed with settings from `@ConfigValue`. The connection pool opens at construction time; `debug: !isProduction` means query logging is on by default outside production.

**Migrations:** a **separate** library, `node-pg-migrate` (which itself depends on `pg`), run via `npm run migrate` → reads `migrate.json`. This means the repo has two Postgres client libraries in its dependencies — `postgres` for app runtime queries, `pg` transitively for migration tooling only (confirmed: nothing in `src/` imports from `"pg"` directly). Intentional-looking (schema tooling vs. app runtime), but worth knowing so it doesn't read as an accident.

Three migrations exist (`src/infrastructure/database/migrations/`), in order:
1. `..._users-table.ts` — creates `users` (`id` int PK "User ID in telegram", `first_name`, `last_name`, `username`, `is_bot` boolean, `last_active_time`/`created_time`/`updated_time` timestamptz).
2. `..._create-sessions-table.ts` — creates `sessions` (`key` unique string, `value` jsonb, timestamps) — backs the grammY session storage adapter (§5).
3. `..._change-id-column-type-on-users-table.ts` — widens `users.id` from `integer` to `bigint` (a bug-fix migration: Telegram user IDs can exceed the 32-bit signed int range).

`migrations/common/utils.ts`/`common/template.ts` hold shared column shorthands and the scaffold template used by `node-pg-migrate` when generating new migration files.

**Repository coverage:** only `users` has a repository (`PgSqlUserRepository`, §8); `sessions` is read/written directly by `PgsqlStorage` with no repository layer — an inconsistency in how the two tables are accessed.

## 12. Configuration & environment

`Config` (`src/infrastructure/config/config.ts`) loads `.env` via `dotenv` + `dotenv-expand` **at module import time** (so values can reference other vars, e.g. the — unused, see below — `DATABASE_URL` interpolation in `.env.dist`).

Env vars actually consumed by `Config`:

| Var | Purpose |
|---|---|
| `ENVIRONMENT` | `development`/`production`, drives `isProduction` |
| `TEMP_DIR` | base dir for font-convertor temp files |
| `PYTHON_PATH`, `FONT_FORGE_PATH` | external tool paths |
| `LIMIT_COMMON_NUMBER`/`_INTERVAL`, `LIMIT_PRIVATE_NUMBER`/`_INTERVAL`, `LIMIT_GROUP_NUMBER`/`_INTERVAL` | rate-limit config for `Planner`/`SlotManager` (§6) |
| `BROKER_SLEEP_INTERVAL` | `Broker` poll interval |
| `BOT_TOKEN` | required — `Bot`'s constructor throws if empty |
| `LOGGER_DEFAULT`, `LOGGER_LEVELS` | which logger backend + which levels are active |
| `DATABASE_HOST`, `_PORT`, `_NAME`, `_USER_NAME`, `_USER_PASSWORD`, `_CONNECTION_LIMIT`, `_CONNECTION_IDLE_TIMEOUT`, `_CONNECTION_MAX_LIFETIME` | Postgres connection |

Vars present in `.env.dist` but **not read anywhere in `src/`**: `DATABASE_SUPERUSER_NAME`/`_PASSWORD` and `DATABASE_TIMEZONE`/`DATABASE_DATE_STYLE` (consumed only by `docker-compose.yml`/the init script, not the app), and notably **`DATABASE_URL`** — built via string interpolation but never actually read by `Database`/`Config`, which always assembles the connection from discrete host/port/user/pass fields. Treat `DATABASE_URL` as vestigial unless some external tooling outside this repo depends on it.

`.env.dist` also commits a real-looking plaintext `BOT_TOKEN` example value — worth a quick sanity check that it's genuinely inert before assuming it's harmless to have in git history.

## 13. External integrations & dependencies

- **Telegram Bot API** — via grammY + `@grammyjs/runner` (long polling; no webhook mode configured anywhere).
- **FontForge** — external CLI, invoked via `child_process`-style shell-out (§7). Expected on `$PATH` unless `FONT_FORGE_PATH` overrides it.
- **PostgreSQL** — the only external data store (§11).

**Dead dependencies** — declared in `package.json` but with zero usage anywhere in `src/`:
- **`mmmagic`** (+ `@types/mmmagic`) — intended purpose (content-based MIME sniffing) is visible only as commented-out dead code in `font-convertor/convertor/convertor.ts`; the actual `FileHelper.getMimeType()` shells out to the OS `file` command instead, and even that is only reachable from that same dead code block.
- **`puppeteer`** — no usage found anywhere; no rendering/screenshot logic exists in the codebase at all.

## 14. Testing

- **`test/bootstrap.ts`** is completely empty (0 bytes), despite being loaded via `--file test/bootstrap.ts` in the `test` npm script — presumably meant to hold global test setup (e.g. `reflect-metadata`) but currently does nothing.
- **`test/services/message-broker/slot-manager/slot-manager.spec.ts`** is the **only** spec file in the entire repository. It instantiates `SlotManager` directly (no mocks) and checks: fresh manager is free → not free after `reserve()` → free again after the interval elapses → double-`reserve()` throws. The "free again after timeout" assertion is wrapped in a bare `setTimeout` callback with no `done()`/await — Mocha has already returned by the time it runs, so a failing assertion there would **not** actually fail the test run.
- The test's directory path (`test/services/message-broker/...`) predates the source reorg — no `services/message-broker` concept exists in current `src/` (the module is `src/domain/slot-manager/`, called from `src/domain/broker/`) — a leftover from before the "Global refactor" commits.
- `package.json`'s `nyc` config extends `@istanbuljs/nyc-config-typescript`, which is **not installed** (not in `devDependencies`), and no npm script invokes `nyc` at all — the coverage tooling is configured but entirely inert.
- **Net effect:** essentially zero real test coverage. None of the domain services (`Broker`, `Planner`, `FontConvertor`, `UserService`), infrastructure (`Bot`, middlewares, `Config`, the DI container), or helpers have any tests.

## 15. Build & dev workflow

- `npm run build` — `del-cli -rf build && tsc && tsc-alias` (compiles, then rewrites the `app/*` alias to relative paths for the compiled output).
- `npm start` / `npm run start:prod` — `node build/app.js` (the latter sets `NODE_ENV=production`).
- `npm run migrate` — runs `node-pg-migrate` against `migrate.json`.
- `npm test` — `mocha` over `test/**/*.spec.ts` (see §14).
- **Docker** — `docker-compose.yml` runs **only Postgres** (`postgres:14.1-alpine`), env-driven from `.env`, with `docker/pgsql/docker-entrypoint-initdb.d/init-user-db.sh` creating the app's non-superuser DB role/database on first init. **The bot application itself is not containerized** — it's expected to run on the host via `npm start`. No Dockerfile for the app was found (see [Open questions](#18-open-questions--uncertainties)).
- **Linting/formatting** — ESLint (TypeScript + Prettier + import-order rules, and the relative-import ban noted in §3) + Prettier (4-space indent, 140-char lines, double quotes) + Husky `pre-commit` hook running `lint-staged` (`eslint --fix` then `prettier --write` on staged `.ts` files).
- `.nvmrc` is a floating `lts/` alias rather than a pinned Node version — a minor reproducibility gap for onboarding.

## 16. End-to-end flows

This section is a quick summary only. **For the precise trigger → component sequence → branching → state changes → data-store interactions → external calls → error handling → side effects of every major flow, see [`docs/flows.md`](./flows.md)** — it supersedes the brief descriptions below wherever they conflict, since it was produced by a deeper, runtime-behavior-focused verification pass.

**Incoming update:**
session load (Postgres, keyed by user+chat) → `sequentialize()` (serializes same chat/user updates) → `TelegramCallApiMiddleware` (patches `ctx.api.raw` for outbound calls) → `AsyncLocalStorageMiddleware` (tags request-scoped logger) → `ResponseTimeMiddleware` / `RequestLogMiddleware` (timing + logging; **this is where the pipeline actually crashes for updates missing `ctx.from`, not at `FillUserToContextMiddleware` — see §8 and `docs/flows.md` Flow 3**) → `FillUserToContextMiddleware` (upserts the `users` row, stamps `lastActiveTime`) → Fluent locale flavor attached → `IsPrivateChatFilter` (drops non-private-chat updates) → conversation/command dispatch (`/start`, `/font_generator`, `/bulk_messages`).

**Outgoing message (rate-limiting):**
see the diagram in §6 — `TelegramCallApiMiddleware` intercept → `Planner` priority queue, gated by `SlotManager`(s) → `Broker`'s poll loop executes it → **structurally** 429 triggers a global ban and requeue, but per §6's correction this path is very likely never actually reached at runtime.

**`/font_generator`:**
command handler → *(bug: never actually invokes the conversion — see §7 and §17)* → had it been reachable: `FontConvertor.convert()` → `ConvertorFactory` dispatch to a concrete pair convertor → validation (extension + MIME allow-list) → `FontForge` shells out to the `fontforge` CLI → **the resulting file path is sent back as text, not the file itself** (§7). No explicit temp-file cleanup step was found in this path — generated files under `TEMP_DIR/<year>/<month>/<weekday>/` appear to accumulate rather than being deleted after use (unconfirmed whether cleanup happens elsewhere, e.g. an external cron — see [Open questions](#18-open-questions--uncertainties)).

## 17. Known issues / fragile areas

A flat list of everything flagged above, for quick scanning. Items marked **(deep-dive)** were only found by the second, runtime-behavior-focused pass (full detail in `docs/flows.md`) and are the highest-value corrections to the first pass's structural read:

- **(deep-dive, high severity)** `Broker`'s retry-on-failure and ban-on-HTTP-429 logic is very likely dead code at runtime — tracing the exact Promise chain through `TelegramCallApiMiddleware`'s `callback` closure shows `Broker.handleMessage`'s catch block can only fire on a synchronous throw, which real Telegram API failures don't produce (they're async rejections). The bot has no working automatic backoff on rate-limit responses despite the code appearing to implement one (§6, `docs/flows.md` Flow 4).
- **(deep-dive, high severity)** `FillUserToContextMiddleware`'s `if (!ctx.from)` guard is unreachable — `RequestLogMiddleware`, one step earlier in the pipeline, already throws synchronously on `context.session.requestCount++` for any update lacking `ctx.from`, because grammY's session-key resolution requires it. The pipeline silently drops such updates one middleware earlier than the code's own explicit handling for that case (§8, `docs/flows.md` Flow 3).
- **(deep-dive)** `/font_generator` currently does nothing observable when invoked — combined with the `Promise.all`/`.bind` bug below, the command handler produces no reply, no conversion, and no error (`docs/flows.md` Flow 6).
- **(deep-dive)** Neither `/font_generator` nor `/start`'s dead-code twin ever actually sends the converted font file — both reply with the server's local filesystem path as text (§7, `docs/flows.md` Flow 6).
- **(deep-dive)** `FileHelper.createDirectoriesByDate` buckets by day-of-**week** (dayjs `.day()`, 0–6) instead of day-of-month (`.date()`), so the `YYYY/M/D`-shaped temp directory structure actually cycles weekly rather than giving each calendar day its own folder (§7).
- **(deep-dive, elevated severity)** `BulkMessagesCommand` is not just forgotten debug scaffolding — as a live, unauthenticated `/bulk_messages` command reachable by any user who can open a private chat with the bot, it is a genuine abuse vector: invoking it attempts to queue up to 300,000 messages to three hardcoded chat IDs. Its practical blast radius on hosts other than the original developer's machine is limited by an unrelated bug (a hardcoded personal-machine path causing most of the 300,000 calls to fail before reaching `Planner.push`), but that's an accident, not a safeguard (`docs/flows.md` Flow 7).
- **(deep-dive)** `RuntimeError.byError(error)` (`src/common/errors.ts`) always throws a plain `RuntimeError` from inside itself rather than returning one — so `throw FontConvertorError.byError(error)` / `throw ExecuteError.byError(error)` actually throw a base `RuntimeError`, not the named subclass, despite being called via the subclass. No `instanceof FontConvertorError`/`instanceof ExecuteError` check exists anywhere today, so this is currently dormant, but would silently break any future error-type-specific handling.
- **(deep-dive)** `Broker`'s idle-poll interval defaults to 1000ms in code but is overridden to 10ms by the committed `.env.dist` — a much more aggressive default than reading `config.ts` alone would suggest (§6).
- **(deep-dive)** The `TELEGRAM_NO_GROUP_RATE_LIMIT_SET` whitelist in `TelegramCallApiMiddleware` only exempts group-chat calls; the same methods are still queued for private chats. A second constant in the same file, `WEBHOOK_REPLY_METHOD_ALLOW_SET`, is declared but never used anywhere (§5).
- **(deep-dive)** The rate-limiting Proxy only wraps `ctx.api` (a fresh instance per update, per grammY's own source — verified at the locked version `1.10.1`); code calling through `bot.grammy.api` directly bypasses it entirely and must manually replicate the queueing, as `BulkMessagesCommand` does (§5, `docs/flows.md` Flow 4).
- Bootstrap failures are only `console.error`'d, never `process.exit`'d (§2). **(deep-dive)** More precisely, `Bot.run()`'s own internal `try/catch` swallows most startup failures (logs critical, resolves normally) before this outer swallow would ever apply — see `docs/flows.md` Flow 1.
- `Container.close()` is a no-op stub; the Postgres pool is never explicitly closed on shutdown (§2).
- `package.json#main` (`build/src/index.js`) doesn't match the real entry point (`build/app.js`) (§2).
- `Bot.stop()`'s `waitPlannerToEmpty()` loop has no timeout — can hang shutdown indefinitely if the outbound queue never drains (§5).
- `Planner.managers` (a `Map<chatId, SlotManager>`) is never evicted — unbounded memory growth over a long-running process (§6).
- `Planner`'s dequeue scan means delivery isn't strictly FIFO within a priority bucket (§6).
- `broker.errors.ts` and `planner.errors.ts` are empty files, unlike every sibling domain module (§6).
- `Broker.run()`/`.stop()` are synchronous but called with `await` (§6).
- `FontForge`'s shell command is built with unescaped string `.replace()` — currently low-risk since paths are internally generated, but fragile if that ever changes (§7).
- SVG is declared as a supported font extension but has no reachable conversion pairs (§7).
- `mmmagic`-based content sniffing is dead/commented-out code; `mmmagic` and `puppeteer` are both unused dependencies (§7, §13).
- `UserAlreadyExists` error class is defined but never thrown (§8) — dead code.
- `FillUserToContextMiddleware` has an explicit `if (!ctx.from)` guard that returns without calling `next()` — but per the deep-dive entry above, this code is unreachable; the pipeline actually crashes one middleware earlier for the same case (§8).
- `PinoLogger`'s request-correlation Proxy effectively no-ops in development, where `ConsoleLogger` is the default (§9).
- `Logger` is used as both the domain interface and, unrelatedly, a local config-shape type name inside `config.ts` (§9).
- i18n's `localeNegotiator` is hardcoded to `"ru"`; one hardcoded Russian string bypasses Fluent entirely in `StartConversation` (§10).
- `DATABASE_URL` in `.env.dist` is built but never consumed by the app (§12).
- `.env.dist` commits a plaintext, real-looking `BOT_TOKEN` value (§12).
- `sessions` table has no repository layer, unlike `users` — an inconsistent data-access pattern (§11).
- `test/bootstrap.ts` is empty; the one existing test has a non-verifying async assertion; `nyc` coverage config references an uninstalled package with no script to invoke it (§14).
- `BulkMessagesCommand` (`src/infrastructure/bot/command/bulk-messages/`) is registered as a live `/bulk_messages` bot command but contains hardcoded developer chat IDs, a hardcoded personal-machine absolute path, and a `100_000`-iteration loop that would queue 300,000 outbound messages — reads as forgotten load-test/debug scaffolding, but see the elevated-severity deep-dive entry above: unlike `FontGeneratorCommand`'s equivalent bug, this one is actually reachable and user-triggerable, not inert.
- `FontGeneratorCommand.handle()` has a `for (let i = 0; i < 1; i++)` loop that pushes an **unbound function reference** (not its invocation result) into a `promises` array before `Promise.all(promises)` — the pushed value isn't a `Promise`, so `generateRandomFonts` is very likely never actually invoked here (confirmed by the deep-dive pass: `/font_generator` currently does nothing at all when invoked). Looks like leftover debug/stress-test scaffolding, similar in spirit to `BulkMessagesCommand`.
- `is-private-chat.filter.ts` has a typo in a type predicate (`char` instead of `chat`) — currently harmless since only the boolean result is used, but worth fixing if that type gets relied on elsewhere.
- A handful of infrastructure files use dot-case naming (`pgsql.decorator.ts`, `pgsql.storage.ts`, `pgsql.user.repository.ts`, `abstract.logger.ts`, `console.logger.ts`, `pino.logger.ts`) while most of the codebase uses kebab-case — likely leftovers from before the "Global refactor" (kebab-case) commit.
- **Logger abstraction is disproportionate to what this app actually needs.** A domain `Logger` interface, two concrete backends (`Console`/`Pino`), a container-level `Proxy` rebind for request correlation, and an `AsyncLocalStorage`-based child-logger substitution mechanism (§9, §19) together add up to significantly more indirection than a single-process bot with one active logger at a time requires. Worth evaluating whether a plain constructor-injected logger (still swappable via DI, just without the `Proxy`/service-locator layer) would serve the same needs with far less machinery to reason about.
- **Config abstraction is similarly heavier than needed.** `@ConfigValue` resolves dotted-path string keys (e.g. `"bot.token"`) at runtime via a lazy property decorator that reaches into the global container singleton — none of that path is checked against `Config`'s actual shape at the call site, so a typo'd key only fails at first access, not at compile time. A plain constructor-injected settings object (or even direct `Config` injection with typed getters) would give the same runtime behavior with real type safety and no service-locator indirection.

## 18. Open questions / uncertainties

Called out explicitly rather than guessed at:

- **Is `BulkMessagesCommand` intentional?** It could be a deliberate (if crude) internal ops tool for broadcasting, or simply forgotten debug/load-test code that happens to still be registered as a live command. The code itself (hardcoded personal machine path, hardcoded chat IDs) reads much more like the latter — but regardless of original intent, the deep-dive pass confirms it is a live, unauthenticated command any user can trigger today (§17, `docs/flows.md` Flow 7), which raises the practical stakes of answering this question.
- **Is the SVG font-conversion gap and the commented-out `mmmagic` sniffing code paused work or abandoned?** No TODO/comment explains the intent either way.
- **How does this actually get deployed to production?** No Dockerfile for the app itself was found, and `docker-compose.yml` only provisions Postgres. It's unclear whether production runs via plain `npm run start:prod` on a host/VM, some process manager (pm2, systemd) not represented in the repo, or an external deploy pipeline this repo doesn't show.
- **Is `DATABASE_URL` (in `.env.dist`) actually used by something outside this repo** (an external script, a hosting platform's auto-detection, etc.), or is it purely vestigial? The app itself never reads it.
- **Is there any cleanup for generated font-conversion temp files** under `TEMP_DIR/YYYY/M/D/`? None was found in the code path itself; it may happen via an external cron/ops process not visible here, or may simply not happen.

## 19. Invariants and gotchas

A third analysis pass, specifically hunting for implicit rules a new contributor could break without any name, type, or file structure warning them. Several of these are new findings not covered by §17 or `docs/flows.md`; a few cross-reference those docs where the full mechanics are already written up. Each is stated with its confidence level — items marked **(uncertain — flagging, not concluding)** are genuinely ambiguous from the code alone and shouldn't be treated as settled.

### Mandatory execution order

- **`sequentialize()` must keep including `from.id` in its key, or a real check-then-act race opens up.** `FillUserToContextMiddleware` does `existsById(id)` then, based on the boolean, either `create()` or `edit()` — with no transaction or row lock tying the check to the act. This is only safe today because `sequentialize()` (registered in `Bot.setupSequential()`, *before* the middleware composer) serializes all updates sharing the same `from.id`, so two concurrent updates from the same brand-new user can never both observe `existsById() === false` at once. **This is a real, load-bearing dependency between two files that look unrelated** (`session.helper.ts`'s neighbor `sequentialize()` call in `bot.ts`, and `fill-user-to-context.middleware.ts`) — removing `from.id` from the `sequentialize()` key function, or reordering it after the user-fill middleware, would reopen the race. (Postgres's `ON CONFLICT DO UPDATE` upsert in `PgSqlUserRepository.save()` means the race can't corrupt data or throw — worst case is a harmless last-write-wins overwrite between two near-identical writes — but the *intended* create-vs-edit branch selection would become unreliable.)
- **Eager `container.get(...)` calls inside `Container.setup()` must only target classes whose transitive constructor-injected (`@inject`) dependencies are already bound by that point in the phase sequence.** `setupInfrastructureLogger()` (part of `setupInfrastructure()`, the *last* of the three `setup()` phases) calls `this.get()` synchronously for `Config`, `ConsoleLogger`, and `PinoLogger` — forcing real instantiation, not lazy resolution. This works today only because none of those three classes constructor-inject anything bound in an earlier phase. Everything else in the app (`Bot`, `Planner`, `Broker`, etc.) avoids this hazard by using the lazy `@ConfigValue`/`@PgSql` property decorators instead of eager `.get()` — which is very likely *why* those decorators exist, rather than just constructor `@inject`, given `Bot`'s binding happens in phase 1 while `Config`'s happens in phase 3. If you ever add a new eager `.get()` inside `setup()`, check it doesn't reach for something bound later in the sequence, or it will throw at boot with an unhelpful "no matching bindings found."
- **Migrations are strictly append-only and order-dependent** (already noted in §17) — `node-pg-migrate` tracks applied migrations by filename/timestamp; editing an already-applied migration file has no effect on already-migrated databases and only diverges fresh ones from existing ones.

### Assumptions about system state

- **A successfully logged `"Bot is successfully started."` does not mean Postgres is reachable.** `Database`'s constructor calls `postgres({...})` (the `porsager/postgres` client), which — like most modern Postgres clients — establishes the actual TCP connection lazily, on first query, not at construction. Since nothing in the boot sequence issues a query before the bot starts polling, a completely unreachable database will not surface until the *first* real update tries to read/write a session or user row (i.e., potentially well after "successfully started" has been logged, and only when an actual user messages the bot).
- **`ctx.user` is populated exactly once per update, by `FillUserToContextMiddleware`, and nothing before it in the pipeline can rely on it being set.** Anything that reorders middleware ahead of it, or that runs outside the normal update pipeline (e.g. a future background job), must not assume `ctx.user` exists.
- **The rate limiter assumes `LIMIT_*_NUMBER` env vars are always positive integers.** If any of `LIMIT_COMMON_NUMBER`/`LIMIT_PRIVATE_NUMBER`/`LIMIT_GROUP_NUMBER` is ever set to `0` (misconfiguration, not a code path anything guards against), `SlotManager`'s `reserveDuration = interval / number` becomes `Infinity`, so `reserveTimeout = Date.now() + Infinity`, and that scope's slot **never frees again for the life of the process** — a single reservation permanently locks out all further messages in that scope. Not observed in practice (the shipped `.env.dist` values are all sane), but nothing validates this at config-load time.

### Retry mechanisms

- Covered in full in `docs/flows.md` Flow 4 and `docs/architecture.md` §6/§17: `Broker`'s catch-and-retry / ban-on-429 is very likely dead code at runtime, due to an unawaited Promise inside `TelegramCallApiMiddleware`'s `callback` closure. Cross-referenced here because it's exactly the kind of "looks like it works, structurally reads correctly, silently doesn't" trap this section is meant to warn about. If you ever fix the underlying Promise-chain bug, be aware the ban/retry path has **never been exercised in production as far as this analysis can tell** — treat it as unverified, not "restored."
- There is no retry anywhere for the initial Postgres connection, nor for `setMyCommands` at boot (§5) — both are one-shot; a transient failure at startup is fatal to that subsystem for the process's lifetime (or, per §17, silently swallowed by `Bot.run()`'s own catch, leaving the process alive but non-functional).

### Idempotency

- `PgSqlUserRepository.save()` and `PgsqlStorage.write()` are both true upserts (`ON CONFLICT ... DO UPDATE`), so repeated calls with the same data are safe — this is the idempotency property the check-then-act race above quietly relies on.
- `UserService.create()` is **not** "create if not exists, else fail" despite the name — it always upserts. Calling it on an existing user silently overwrites `first_name`/`last_name`/`username`/`is_bot`/`last_active_time`/`updated_time` with whatever's in the `CreateUserDto` (though `created_time` is correctly preserved, since it's excluded from the `DO UPDATE SET` column list). This is relied upon (see above) rather than guarded against.
- `Convertor.validateToPath()` requires the destination path **not** already exist (throws `InvalidPath.isAlreadyExists` otherwise) — font conversion is therefore no relation to overwrite-safe/idempotent; calling it twice with the same generated random filename would fail on the second call. In practice this never collides because filenames are freshly randomized per call, but it means the operation is deliberately non-idempotent by path.

### Special and boundary cases

- `Planner.ban(duration)`: a `duration` of exactly `0` computes `expirationTime = Date.now()`, and the guard `if (expirationTime < Date.now()) return;` will, in practice, almost always evaluate true by the time it runs (even a sub-millisecond gap makes `Date.now()` tick forward) — so a zero-length ban silently does nothing. **(uncertain — flagging, not concluding)** this reads as probably-intentional ("a 0ms ban is a no-op ban," which is reasonable), but it's not obviously deliberate from the code either.
- `TelegramCallApiMiddleware`'s `isGroup = chatId < 0` treats `chatId === 0` as neither a group nor exempted from the private-chat queue path — Telegram never actually issues `chat_id: 0`, so this has no observed effect, but there's no explicit handling either way if that assumption is ever wrong.
- A non-plain-object outbound payload (e.g. a multipart/file-upload body) bypasses the rate-limit queue entirely (`payload.constructor.name !== "Object"` branch in `TelegramCallApiMiddleware`) — already noted in `docs/flows.md` Flow 4, repeated here because it's an easy-to-miss edge case if a future feature ever adds real file uploads: those sends would not be rate-limited by the existing mechanism at all.

### Implicit coupling between modules

- **`domain/logger/logger.types.ts`'s `Level` enum and `infrastructure/logger/pino.logger.ts`'s `pinoLevels` numeric-mapping object are two independently hand-maintained sources of truth**, kept in sync only by convention (both list the same five level names) — nothing in the type system enforces this. Adding a new `Level` without adding a matching entry (with a numeric value strictly between the neighboring levels, since pino requires ascending values) to `pinoLevels` would compile fine and fail at runtime the first time that level is logged through `PinoLogger`.
- **Adding a new trackable field from Telegram's `ctx.from` (e.g. `language_code`) requires four files to change in lockstep, with no compiler check tying them together beyond the DTO's own shape:** `user.types.ts` (`UserDto`/`UserRow`/`CreateUserDto`/`EditUserDto`), `user.ts` (entity field + getter/setter), the relevant migration (new column) — and, separately, `pgsql.user.repository.ts`'s `rowToEntity`/`entityToRow` mappers, and `fill-user-to-context.middleware.ts`'s manual field-by-field mapping from `ctx.from`. TypeScript will happily compile if you forget the migration (the mismatch only surfaces as a runtime SQL error, "column does not exist," on the next upsert).
- **`config.logger.default` (env `LOGGER_DEFAULT`) doesn't just pick a logger — it silently determines whether request-correlated logging (`AsyncLocalStorageMiddleware`) does anything at all**, since that middleware's `instanceof PinoLogger` check is the only thing gating it. Switching the default logger to `ConsoleLogger` (the development default) doesn't just change formatting, it removes request correlation entirely — non-obvious from either file in isolation (`config.ts` and `async-local-storage.middleware.ts` don't reference each other directly; the connection only exists via the container wiring in `setupInfrastructureLogger()`).
- **Migration column order and `PgsqlStorage.write()`'s positional `INSERT ... VALUES (key, value)` (no explicit column list) are implicitly coupled** — already detailed in `docs/architecture.md` §11/§16; repeated here as a "changing one silently breaks the other" example: reordering columns in the `sessions` migration (or adding a new required column before `created_time`) would silently misassign values or break the insert, with nothing in `pgsql.storage.ts` itself hinting at this dependency.

### Unusual validation

- Font-file MIME validation (`Convertor.validateFromPath`) derives the "MIME type" from the file's **extension** via the `mime-types` package (`mime.lookup(extension)`), not from file content — despite reading as content-type validation, it's really just "does this extension look plausible for this scheme." A corrupt or malicious file with a correct extension passes. The commented-out content-sniffing block (§7) shows this was apparently meant to be stronger at some point.
- `getMimeType()` in `FileHelper` throws `PermissionDenied.write(path)` when a file is *not readable* — the error type/message says "write" for what is actually a *read* permission check. **(uncertain — flagging, not concluding)** this looks like a copy-paste mistake (there's an identical, correctly-labeled `PermissionDenied.read` used elsewhere in the same file), but since `getMimeType()` itself is only reachable from the commented-out dead code in `convertor.ts`, it has no live effect either way.

### Concurrency assumptions

- `sequentialize()`'s key function returns `[chat.id, from.id]` as two independent keys (not one combined key) — for a **private** chat, Telegram's convention makes `chat.id === from.id` numerically, so both entries are the same string; harmless (redundant lock on one key), but worth knowing so it isn't mistaken for a bug. For **group** chats (not currently reachable past `IsPrivateChatFilter`, but the rate-limit config for groups exists — see §6/§18), the two would differ, and a user's updates across two different chats would still be serialized against each other via the shared `from.id` key, not just updates within one chat. This is required for the `existsById`/`create`/`edit` race-freedom above, not an accidental side effect.
- The DI container itself is a single **global** module-level singleton (`export const container = new Container()` in `container.ts`), and `@ConfigValue`/`@PgSql` decorators reach into it directly (`import { container } from "app/infrastructure/container/container"`) rather than through constructor injection. **This means any class using these decorators cannot be isolated for unit testing via a separate `Container` instance** — it will always read from the one global container, regardless of what test setup constructs. Not a live bug (nothing in the (near-nonexistent) test suite currently attempts this), but a real constraint on how testable these classes are without refactoring away from the decorator pattern.
- Property decorators (`ConfigValue`, `PgSql`) close over a single `value`/`sql` variable defined **once, at class-definition time**, and `Object.defineProperty` the getter onto the **class prototype** (a property decorator's `target` is the prototype, not a per-instance object) — so the cached value is **shared across every instance of that class**, not cached per-instance. Today this is harmless because every class using these decorators is bound `.inSingletonScope()` in `container.ts` (verified — `StartConversation` is the only non-singleton binding in the whole container, and it uses neither decorator). **(uncertain — flagging as a landmine, not a live bug):** if a future non-singleton class is given a `@ConfigValue`/`@PgSql` property, all instances would silently share one cached resolution rather than each resolving independently — surprising, since nothing about the decorator's name suggests prototype-level sharing.

### Backward compatibility

- `User.id` and `Message.chatId` are represented as plain JS `number` throughout the domain and infrastructure layers, while the underlying `users.id` column is `bigint` (widened from `integer` specifically because Telegram IDs exceeded 32-bit range — §11). JS `number` is only safely precise up to `2^53 - 1`; current Telegram IDs are comfortably within that range, but the type choice itself doesn't protect against a future ID scheme that isn't. Not an active problem, but worth knowing before assuming `bigint` in Postgres implies full precision safety end-to-end.

### Magic constants

A non-exhaustive catalogue of hardcoded values with no named-constant treatment, collected here since they're easy to trip over when refactoring nearby code: `Bot.waitPlannerToEmpty`'s poll interval (`3000` ms, hardcoded, not configurable via env); `Planner.logMessageCount`/`logBanExpires`'s reporting interval (`10000` ms each, two separate `setInterval` calls with the same hardcoded value, not sharing a constant); `StringHelper.generateRandomString(15)` for font temp filenames; the pino custom level numbers (`debug=0, info=100, warning=200, error=300, critical=400` in `pino.logger.ts`) — see the "implicit coupling" entry above; and the three hardcoded chat IDs plus `100_000`/`1` loop bounds in `BulkMessagesCommand`/`FontGeneratorCommand` (already covered in §17 as debug leftovers, not "real" magic constants in the configuration sense, but worth remembering they're hardcoded literals rather than config).

### Logic that looks strange but is likely intentional

- `Planner.pullByPriority`'s O(n) scan-and-skip (rather than strict FIFO) within each priority bucket — deliberately avoids head-of-line blocking when the front message's chat happens to be rate-limited. Confirmed as sound design, not a bug, despite breaking the naive expectation that a queue delivers in insertion order.
- The extensive Russian-language comments scattered through the trickiest code (`TelegramCallApiMiddleware`'s Proxy hack in particular) are, in effect, the closest thing this codebase has to design rationale for its least-obvious mechanism — worth reading even if you don't otherwise need Russian, since they explain *why* the hack exists, not just what it does.
- `RequestLogMiddleware` incrementing `session.requestCount` on every update, with the resulting counter never read or displayed anywhere in the codebase. **(uncertain — flagging, not concluding):** this could be scaffolding for a future per-user analytics or abuse-detection feature, or simply dead instrumentation left over from earlier development — nothing in the code indicates which.
