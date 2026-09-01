# End-to-end flows

This document traces the system's actual runtime behavior — not just what the code structurally appears to do, but what it does when executed, including exact Promise/async semantics and interactions with the underlying grammY framework. It is the result of a second, deeper analysis pass on top of [`docs/architecture.md`](./architecture.md), specifically aimed at verifying claims made there against runtime behavior.

**Methodology note:** several findings below depend on exactly how grammY (pinned at `1.10.1` in `package-lock.json`) behaves internally — not just this repo's code. Those points were checked against grammY's actual source at tag `v1.10.1` rather than assumed from general familiarity with the framework, because a wrong assumption here would produce a wrong flow description. Where that mattered, it's called out explicitly.

This pass found **four confirmed runtime bugs that the first (structural) pass missed**, all corrected in `docs/architecture.md` as well:

1. The `/font_generator` and `/start` commands' debug code never actually sends the generated font file to the user — it sends the server's local filesystem path as a text message.
2. `FillUserToContextMiddleware`'s `if (!ctx.from)` guard is unreachable dead code — the pipeline already crashes one middleware earlier (`RequestLogMiddleware`) for any update lacking `ctx.from`, because grammY's session middleware throws on `ctx.session` access when its key function returns `undefined`.
3. `FileHelper.createDirectoriesByDate` buckets font-conversion temp files by **day of week** (0–6), not day of month, because it calls dayjs's `.day()` instead of `.date()`.
4. Tracing the exact Promise chain through `TelegramCallApiMiddleware` → `Broker` shows that `Broker`'s catch-and-retry / ban-on-429 logic is very likely **dead code at runtime** — it can only trigger on a synchronous throw, which the real Telegram API call essentially never produces.

Each is detailed in its flow below.

---

## 1. Process bootstrap

**Trigger:** process start (`node build/app.js`, i.e. `npm start`/`npm run start:prod`).

**Sequence:**
1. `src/app.ts` imports `reflect-metadata` (must happen before any inversify-decorated class is loaded, or `@injectable()`/`@inject()` metadata won't exist).
2. `container.setup()` runs synchronously-in-sequence (see `docs/architecture.md` §4 for the full binding tree): `setupModules()` (binds `Planner`, `Broker`, then all of `setupBot()`'s bindings) → `setupServices()` (font-convertor + user stacks) → `setupInfrastructure()` (`Config`, `Database`, then `setupInfrastructureLogger()`).
   - `Config`'s constructor runs `dotenvExpand.expand(dotenv.config())` **at module import time** (top-level statement in `config.ts`, not inside the constructor) — meaning `.env` is actually loaded the first time `config.ts` is imported by anything, which in practice is very early (transitively, almost every DI-bound class imports something that imports `Config`).
   - `Database`'s constructor calls `postgres({...})`, which opens a connection pool immediately — **this happens during `container.setup()`, before the bot ever tries to use the database**, so a wrong DB config fails fast at boot rather than on first query.
3. `container.get<Bot>(Modules.Bot.Bot)` resolves the `Bot` singleton. `Bot`'s constructor: reads `@ConfigValue<BotSettings>("bot")` → if `settings.token` is falsy, **throws synchronously** (`throw new Error("Bot token cannot be empty!")`) before `bootstrap()` even reaches `bot.run()`.
4. `await bot.run()`:
   - `await this.broker.run()` — **note:** `Broker.run()` is actually synchronous (`public run(): void`), so this `await` is a no-op wrapper around a synchronous call; it doesn't block on anything. It throws if `Broker.isRun` is already `true` (defensive check against double-start; not reachable via normal boot).
     - Inside, `Broker.run()` sets `_isRun = true` and schedules `setTimeout(this.handleMessages.bind(this), 0)` — the outbound-queue worker loop starts on the next tick, independent of the rest of bootstrap.
   - `await this.setup()` — runs the full grammY pipeline registration (session → sequentialize → middlewares → flavor/i18n → filters → conversations → commands). See Flow 3 for what "commands" registration does over the network. This is where **`setupFlavor()`** globs `.ftl` files from disk (see Flow 8) and **`setupCommands()`** makes a live `setMyCommands` call to the Telegram API.
   - `this.grammy.catch(this.handleError.bind(this))` — registers the top-level error handler (see Flow 3 for what reaches it).
   - `this.runner = run(this.grammy)` — starts `@grammyjs/runner`'s long-polling loop. This is a fire-and-forget call: `run()` starts polling in the background and returns a handle immediately; it does not await the polling loop's completion.
   - `this.isRun = true`, logs `"Bot is successfully started."` at `info`.
   - **If any step in `try` throws** (bad token already threw earlier and would abort the whole process differently — see below; but e.g. `setup()` throwing due to a `.ftl` glob failure or the `setMyCommands` network call failing): the `catch` block runs `this.broker.stop()` then `await this.handleError(error)` (logs `critical`), and `run()` returns normally (resolves) despite the failure — **`Bot.run()` never rejects**, it always resolves once its internal `try/catch` has run. This means `bootstrap()` in `app.ts` will also resolve successfully even if the bot completely failed to start, and `bootstrap().catch(console.error)` in `app.ts` will **not** fire — the process stays alive, having only logged a critical error, with no bot actually running (no runner, no listening loop). This is a more precise version of the "bootstrap failures are swallowed" issue noted in architecture.md §2/§17: the swallowing happens *inside* `Bot.run()`, not (only) at the `bootstrap().catch()` level.

**State changes:** DI container fully populated and locked (`alreadySetup = true`); one Postgres connection pool opened; `Broker._isRun = true`; `Bot.isRun`/`isSetup = true` (assuming no error).

**Data store interactions:** Postgres connection pool opened (no queries yet at this point).

**External calls:** `grammy.api.setMyCommands(commands)` — one HTTP call to Telegram, made during `setupCommands()` (part of step 4's `setup()`).

**Error handling:** `Bot` constructor throwing (missing token) is **not caught anywhere** — it propagates out of `container.get<Bot>(...)` in `app.ts`'s `bootstrap()`, which *is* wrapped by `bootstrap().catch(console.error)`, so this specific failure mode does log to console (via `console.error`, not the structured `Logger`) and leaves the process alive but idle, same end state as the case above. Everything else inside `Bot.run()`'s own `try` is caught internally as described above.

**Side effects:** one Telegram API call (`setMyCommands`) on every process start, regardless of whether commands actually changed.

---

## 2. Process shutdown

**Trigger:** `SIGINT` or `SIGTERM` (e.g. `Ctrl+C`, `docker stop`, a process manager's stop signal). Both are wired via `process.once(...)` in `app.ts`, so **only the first signal received is handled** — a second `SIGINT` while shutdown is in progress does nothing extra (no forced-exit fallback).

**Sequence:**
1. `stop()` (`app.ts`) → `bot.stop()` → `container.close()`.
2. `Bot.stop()`:
   - Logs `"Stop bot..."`.
   - If `!this.isRun`, logs `"Bot is not running!"` and returns immediately (no-op).
   - If the runner is running, `await this.runner.stop()` — stops long-polling; no new updates are fetched from Telegram after this, but updates already in flight through the middleware pipeline continue running to completion (grammY runner semantics; not itself verified in this repo's code, but standard for `@grammyjs/runner`).
   - `await this.waitPlannerToEmpty()` — polls `planner.isEmpty()` every 3000ms in an **unbounded `while (true)` loop with no timeout and no maximum iteration count**. `isEmpty()` only checks that the three priority buckets have zero *queued* messages — it does **not** check whether the `Broker`'s current in-flight `handleMessage()` call has actually finished. If the queue is non-empty because of the retry-requeue-on-error bug described in Flow 4 (a message that keeps failing and getting pushed back to `HIGH` priority forever), **this loop never returns**, and process shutdown hangs indefinitely — `SIGTERM`/`SIGINT` handling never completes, and (depending on the host's process supervisor) the process may need to be force-killed (`SIGKILL`) to actually stop.
   - `await this.broker.stop()` — sets `Broker._isRun = false`. Because `Broker.handleMessages()`'s recursive loop checks `this.isRun` at the top of each iteration (see Flow 4), the loop will exit on its next iteration rather than immediately — but since `stop()` doesn't await that loop's actual termination, there's a small unguarded race between "planner reports empty" and "broker's loop has actually stopped recursing."
   - `this.isRun = false`, logs `"Bot is successfully stopped."`.
3. `container.close()` — `Container.close()` is a stub: `if (!this.alreadySetup) return;` and otherwise does **nothing else at all** — no `alreadySetup = false` reset, no `database.sql.end()` call. The Postgres connection pool from Flow 1 step 2 is **never explicitly closed**; the process relies entirely on process exit to tear down the TCP connections (which works, but means a graceful `SIGTERM` doesn't actually drain/close the DB pool cleanly — e.g., in-flight queries at the moment of exit are just abandoned rather than allowed to finish or explicitly cancelled).

**State changes:** `Bot.isRun = false`; `Broker._isRun = false` (eventually); DI container state otherwise untouched (`alreadySetup` stays `true` forever, meaning `container.setup()` would be a no-op if ever called again in the same process — not relevant in the current codebase since nothing calls it twice, but relevant if this process were ever adapted to restart the bot in-place).

**Data store interactions:** none explicitly (pool is abandoned, not drained).

**External calls:** none beyond what the still-in-flight update processing (if any) triggers.

**Error handling:** none of `stop()`'s steps are wrapped in try/catch; an exception anywhere in this chain (e.g. `runner.stop()` rejecting) would propagate out of the `process.once("SIGINT"/"SIGTERM", stop)` handler as an unhandled promise rejection, which Node.js would report to stderr and, depending on Node version/flags, could crash the process outright — an abrupt, not graceful, shutdown path.

**Side effects:** none beyond logging, unless the unbounded `waitPlannerToEmpty()` loop never resolves, in which case the practical side effect is "the process must be force-killed."

---

## 3. Incoming Telegram update → middleware pipeline

**Trigger:** `@grammyjs/runner`'s long-polling loop receives an update from Telegram (`getUpdates`) and hands it to grammY's `Bot.handleUpdate(update, ...)`.

**Important framework detail (verified against grammY `v1.10.1` source, `src/bot.ts`):** for every single update, grammY constructs a **brand-new `Api` instance** — `const api = new Api(this.token, this.clientConfig, webhookReplyEnvelope)` — copies over `bot.api`'s installed transformers, and passes this fresh instance into the `Context` constructor. **`ctx.api` is therefore never the same object as `bot.api`, and no two updates ever share an `Api` instance.** This matters directly for Flow 4.

**Sequence (middleware pipeline, in exact registration order from `Bot.setup()`):**

1. **Session middleware** (`session({ initial: initialPayload, getSessionKey, storage: PgsqlStorage })`, grammY core, wired in `setupSession()`).
   - `getSessionKey(ctx)` (`session.helper.ts`) returns `` `${ctx.from.id}:${ctx.chat.id}` ``, or **`undefined`** if either `ctx.from` or `ctx.chat` is missing.
   - **Branch A (key resolved):** grammY's session middleware lazily loads the row for that key from `PgsqlStorage.read(key)` (a `SELECT * FROM sessions WHERE key = ...`) on first access to `ctx.session` within this update, or uses `initialPayload()` (`{ requestCount: 0 }`) if no row exists yet. `next()` is called; after the downstream chain completes, if the session data was read/touched and is dirty, grammY writes it back via `PgsqlStorage.write(key, value)` (an upsert into `sessions`, see architecture.md §11 for the exact query — note it uses a positional `VALUES (key, value)` without an explicit column list, relying on `created_time`/`updated_time` having `DEFAULT now()` in the migration; this is a real but currently-harmless coupling to column order).
   - **Branch B (key resolution fails, `ctx.from` or `ctx.chat` missing — e.g. a channel post):** grammY still calls `next()` immediately (verified against `v1.10.1` source), so the pipeline proceeds — but the `session` property definition on `ctx` is set up such that **the first access to `ctx.session` throws synchronously** (`"Cannot access lazy session data because ... returned undefined for this update!"`). No session read/write happens for this branch (there's nothing to read or write).

2. **`sequentialize()`** (`@grammyjs/runner`, wired in `setupSequential()`) — computes a key array from `[ctx.chat?.id, ctx.from?.id]` (whichever are present) and ensures updates sharing any of those keys are processed one-at-a-time relative to each other, even though the runner fetches/dispatches updates concurrently. This exists specifically so that two updates from the same user/chat can't race on `ctx.session` reads/writes.

3. **`TelegramCallApiMiddleware`** — see Flow 4 for full detail. Synchronously mutates `ctx.api.raw` (the fresh per-update instance from the framework note above) to a `Proxy`, then calls `next()`. No error branch of its own — `handle()` itself can't throw under normal conditions.

4. **`AsyncLocalStorageMiddleware`** — resolves `Infrastructure.Logger` from the container. If it's **not** a `PinoLogger` instance (i.e. `ConsoleLogger` is the active default — the development default), it just calls `next()` and does nothing else: **no request correlation happens in this mode.** If it **is** a `PinoLogger`, it creates `logger.child({ requestId: uuid() })` and runs the rest of the pipeline inside `asyncLocalStorage.run(new Map([["logger", child]]), next)` — from this point on, for the remainder of this update's processing (and anything reachable via async continuation from it), any code that resolves `Infrastructure.Logger` through the container's `PinoLogger` Proxy binding gets this per-request child logger instead of the shared singleton (see `docs/architecture.md` §4/§9).

5. **`ResponseTimeMiddleware`** — records `Date.now()`, `await next()`, then logs `` `Response time: ${end - start} ms` `` at `info`. **No try/catch** — if `next()` rejects (as it will in Branch B below), this middleware's own call rejects too, and the timing log line never executes.

6. **`RequestLogMiddleware`** — `context.session.requestCount++` is the **first statement**, followed by `this.logger.debug("Request", context.update)` (logs the **entire raw Telegram update object** — this includes message text and any user-identifying fields from `ctx.update.message.from`, at `debug` level; worth noting as a data-exposure consideration if debug-level logs are ever shipped somewhere less trusted than local disk).
   - **Branch A (session key resolved in step 1):** increments and persists (eventually, via the session write-back in step 1's downstream) the per-user+chat request counter. This is the *only* place `SessionPayload.requestCount` is ever read or written in the whole codebase — it's tracked but never displayed or acted on anywhere.
   - **Branch B (session key was `undefined`):** `context.session` throws synchronously the moment it's accessed here. **This is a confirmed runtime bug finding:** the exception propagates up through `ResponseTimeMiddleware`'s un-guarded `await next()`, through `AsyncLocalStorageMiddleware`'s `next` (whether or not it went through the `asyncLocalStorage.run()` wrapper — an exception inside the callback still propagates out of `.run()` normally), through `sequentialize()` and the session middleware's own internal try (grammY's session middleware does not swallow downstream errors — see the comment `// no catch: do not write back if middleware throws` in its source, meaning it deliberately re-throws), and ultimately out of grammY's `run(this.middleware(), ctx)` call inside `handleUpdate`, which grammY re-wraps as a `BotError` and hands to whatever was registered via `bot.catch(...)` — i.e. `Bot.handleError`, which logs `critical("Unhandled error on bot", error)`. **Processing of that update stops at this point.** `FillUserToContextMiddleware`, the i18n flavor, the private-chat filter, and all command/conversation dispatch **never run** for such an update.
   - **Consequence:** `FillUserToContextMiddleware`'s own explicit guard, `if (!ctx.from) { this.logger.error(...); return; }`, is **unreachable in practice** — by the time control could reach it, the pipeline has already thrown at `RequestLogMiddleware` for exactly the same class of update (any update missing `ctx.from`, since `getSessionKey` requires it). The guard is dead code; `docs/architecture.md`'s original description of it as "the mechanism by which such updates are silently dropped" is corrected to reflect that the real drop mechanism is this earlier, unhandled exception, not that explicit check.

7. **`FillUserToContextMiddleware`** (only reached when `ctx.from` is present, per the above — meaning its own `if (!ctx.from)` branch has no live path in normal operation):
   - `await this.userRepository.existsById(ctx.from.id)` — `SELECT id FROM users WHERE id = ...`.
   - **Branch A (exists):** `userService.edit(ctx.from.id, {...})` → `UserService.edit` does `repository.getById(id)` (another `SELECT * FROM users WHERE id = ... LIMIT 1`, i.e. **two separate `SELECT`s against `users` per update** for a returning user, plus the eventual `save()` — three round-trips total), applies the partial DTO fields to the loaded `User` entity's setters (each setter auto-stamps `updatedTime`), then `repository.save(user)` (`INSERT ... ON CONFLICT (id) DO UPDATE ...`).
   - **Branch B (doesn't exist):** `userService.create({...})` → builds a fresh `User` with `lastActiveTime = createdTime = updatedTime = dayjs()` (all equal to "now"), then `repository.save(user)` (the same upsert query — relied upon as the actual duplicate-prevention mechanism, since `create()` does no existence check itself).
   - Either branch sets `ctx.user` to the resulting `User` entity — **this is the only place `ctx.user` is populated**; any command/conversation code downstream that reads `ctx.user` depends on this middleware having run without throwing.
   - `next()` is called at the end of both branches.
   - **Error handling:** none — if `existsById`, `edit`, or `create` throws (e.g. a DB error, or `UserCreateError`/`UserEditError` wrapping a DB failure), it propagates unguarded up to `Bot.handleError`, same terminal path as Branch B above (update processing stops, nothing downstream runs, critical log emitted).

8. **Fluent i18n flavor** (`useFluent(...)`) — attaches `ctx.t(key, params)` bound to whatever `localeNegotiator` returns, which is **hardcoded to always return `"ru"`** regardless of the update's actual locale/user. No conditional logic, no state read.

9. **`IsPrivateChatFilter`** — `ctx.chat?.type === "private"`. If **false** (group, supergroup, channel), grammY's `composer.filter()` simply **stops the chain here** — this is not an error, no exception, just normal filtered-middleware behavior; nothing downstream (conversations, commands) runs for non-private chats. This is the mechanism that makes the whole bot private-chat-only in practice, despite the group rate limits configured in `Planner` (see architecture.md §6) implying group chat support was intended/partially built.

10. **Conversations** (`conversations()` + one `createConversation(...)` per registered handler) — grammY's conversation plugin intercepts updates for chats currently "inside" a conversation (tracked via session-backed state, using the same `PgsqlStorage`-backed session as step 1) and routes them to the relevant `ConversationHandler.handle()` instead of falling through to normal command matching. See Flow 5.

11. **Commands** (`composer.command(name, handler)` per registered `Command`) — grammY matches `/command` text against registered command names and dispatches to `Command.handle(ctx)`. See Flows 5–7 for each concrete command.

**State changes (summary across a "happy path" update):** `sessions` row read and (if dirty) upserted; `users` row read (1–2 times) and upserted; `ctx.user`/`ctx.session` populated for the duration of this update's processing (discarded after, not held anywhere longer-lived).

**Data store interactions (summary):** up to 1 `SELECT` + 1 upsert on `sessions`; up to 2 `SELECT`s + 1 upsert on `users`, per update that reaches `FillUserToContextMiddleware`.

**External calls:** none in the pipeline itself (outbound Telegram calls are triggered by whatever the command/conversation handler does — see Flow 4).

**Error handling (summary):** there is exactly one top-level catch-all (`Bot.handleError`, registered via `grammy.catch(...)`), and it does nothing but log at `critical` — no retry, no user-facing error message is ever sent back to the Telegram user whose update caused the failure. From the user's perspective, a failing update just produces no bot response, with no indication anything went wrong.

**Side effects:** DB writes as above; log lines at `debug` (raw update payload, if `RequestLogMiddleware`'s branch A is taken), `info` (response time), and possibly `critical` (any unhandled error).

---

## 4. Outbound Telegram API call (the rate-limiting pipeline)

**Trigger:** any code calling a method on `ctx.api` (directly, or indirectly via convenience methods like `ctx.reply(...)`, which call `ctx.api.sendMessage(...)` under the hood) during the processing of some update.

**Scope — important correction to the first-pass doc:** this interception mechanism is installed by `TelegramCallApiMiddleware.handle()`, which runs once per update and mutates **that update's own freshly-created `ctx.api`** (per the framework note in Flow 3 — every update gets its own `Api` instance from grammY, never shared with `bot.grammy.api` or with any other update). Two consequences, neither obvious from reading `telegram-call-api.middleware.ts` in isolation:
- There is **no cross-update accumulation** of `Proxy` wrapping — each update independently wraps its own pristine `.raw`, and that wrapped instance is discarded once the update finishes processing. (An earlier hypothesis considered during this analysis — that repeated per-update wrapping might stack `Proxy` layers on a shared `Api` object — was checked against grammY's actual source and disproven: `handleUpdate` constructs `new Api(...)` fresh every time. Noted here so the disproven idea isn't accidentally rediscovered later.)
- Code that instead calls through **`bot.grammy.api`** directly (the bot-level singleton `Api` created once in `Bot`'s constructor) **completely bypasses this interception** — that instance's `.raw` is never touched by `TelegramCallApiMiddleware`. `BulkMessagesCommand` and the dead `StartCommand.sendRandomText` method both do exactly this, and both compensate by manually calling `planner.push(...)` themselves rather than relying on the automatic interception — i.e., the two mechanisms (automatic via `ctx.api`, manual via direct `planner.push`) coexist by necessity, not by shared code.

**Sequence, for a call made through `ctx.api` (the common case, e.g. `ctx.reply(text)`):**

1. grammY's `Api` layer builds a plain JS object payload (e.g. `{ chat_id, text }`) and calls `ctx.api.raw[method](payload, signal)`. Because `ctx.api.raw` was replaced with a `Proxy` in step 3 of Flow 3, this triggers the proxy's `get` trap, which returns `callApi.bind(api, method)`.
2. `callApi(method, payload, signal)` runs:
   - **Branch — not a trackable call:** `payload.constructor.name !== "Object"` (e.g. a `FormData`-like payload used for methods that upload a file directly, or any non-plain-object payload) **or** `!("chat_id" in payload)` → calls `originRaw[method](payload, signal)` directly, bypassing the queue entirely. **This means any Telegram API call that uploads a file as multipart form data is never rate-limited by this mechanism** — only plain-object (typically JSON-payload) calls are. Neither `/font_generator` nor `/start`'s debug code actually uploads a file (see Flow 6/7 finding #1), so this branch isn't exercised by any live path in the current codebase, but it's a real gap in the interception's coverage.
   - **Branch — group-exempt:** `chatId = Number(payload.chat_id)`; `isGroup = chatId < 0` (negative IDs are Telegram's convention for groups/supergroups); if `isGroup && TELEGRAM_NO_GROUP_RATE_LIMIT_SET.has(method)` (a 5-method whitelist: `getChat`, `getChatAdministrators`, `getChatMembersCount`, `getChatMember`, `sendChatAction`) — calls `originRaw[method](payload, signal)` directly. **Note this whitelist only ever applies to group chats** — for private chats, none of these methods (nor any other) skip the queue; every plain-object, `chat_id`-bearing private-chat call goes through the queue, even cheap read-only calls like `getChat`.
   - **Branch — `isNaN(chatId)`:** also bypasses the queue directly (defensive handling for malformed/missing chat IDs).
   - **Default branch — queued:** creates a `Promise` (capturing its `resolve`/`reject` as `messageResolve`/`messageReject`), builds a `callback` closure (see step 3), and calls `planner.push({ chatId, isGroup, priorityOnError: PRIORITY.HIGH, callback }, PRIORITY.MEDIUM)` — **all calls entering the queue this way are pushed at `MEDIUM` priority**; nothing in the automatic-interception path ever produces a `HIGH`- or `LOW`-priority message (those only appear via the manual `planner.push()` calls in `BulkMessagesCommand`/`StartCommand`'s dead code, and via `priorityOnError` on retry — see below). Returns the `Promise` to the caller (i.e., back up through grammY's `Api` layer to whatever awaited `ctx.reply(...)`).
3. **`Planner.push`** appends the message object to the `MEDIUM` array. No slot check happens at push time — only at pull time.
4. Independently, `Broker`'s self-recursing loop (started in Flow 1, and looping continuously for the life of the process while `_isRun` is true) calls `Planner.pull()` on each iteration:
   - Returns `null` immediately if globally banned, if all three queues are empty, or if the shared `commonManager` `SlotManager` isn't free (`common`: 30/1000ms by default, or whatever `LIMIT_COMMON_*` resolves to).
   - Otherwise scans `HIGH` → `MEDIUM` → `LOW`; within each bucket, scans front-to-back for the first message whose *per-chat* `SlotManager` (lazily created per `chatId`, using `group`/`private` limits — `.env.dist` defaults: 3/1000ms private, 20/60000ms group) is free. If found: **reserves both the common slot and the per-chat slot**, splices the message out of its bucket (so it's not found again), and returns it.
   - If no eligible message is found in any bucket (e.g. the only queued messages are all rate-limited on their specific chat), returns `null` even though the queues aren't empty.
5. **When `pull()` returns a message,** `Broker.handleMessage(message)` runs: `try { await message.callback(); } catch (error) { this.handleError(error); this.planner.push(message, message.priorityOnError); }`.
6. **`message.callback()` is the closure built in step 2:** `async () => { try { messageResolve(originRaw[method](payload, signal)); } catch (e) { messageReject(e); } }`.

**This is where the confirmed runtime bug lives.** `originRaw[method](payload, signal)` is grammY's real, unproxied raw API call — an `async` method that performs the actual HTTP request to Telegram and **returns a Promise**; it does not throw synchronously under normal failure conditions (network errors, HTTP 4xx/429/5xx, etc. all surface as *rejections* of that returned Promise, not synchronous exceptions — this is standard behavior for an `async function`-based HTTP client and is not something this analysis had to guess at, since any function declared `async` in JS cannot throw synchronously to its caller; a `throw` inside one becomes a Promise rejection). The `callback` closure does **not `await`** that inner call — it just passes the pending Promise straight into `messageResolve(...)`. Per Promise semantics, resolving a Promise with another Promise (a thenable) makes the outer Promise "adopt" the inner one's eventual state — so the **original caller's Promise** (what `ctx.reply(...)` etc. actually awaits) *does* correctly end up rejected if the real Telegram call fails, once that eventually settles.

But `callback()` **itself**, as an `async function` whose body contains no `await` at all, completes synchronously (no error, `messageResolve` doesn't throw for being handed a Promise) and its own returned Promise resolves to `undefined` on the next microtick — **independent of whether the real Telegram call later succeeds or fails.** Consequently:

- `Broker.handleMessage`'s `await message.callback()` will, in essentially all real-world conditions, resolve without throwing.
- Its `catch` block — the only place `handleError` (which detects HTTP 429 and calls `planner.ban(retry_after * 1000)`) and the requeue-on-failure (`planner.push(message, message.priorityOnError)`) are invoked — is therefore **very unlikely to ever run in practice**. It would only run if `originRaw[method]` itself threw *synchronously*, which would require a bug in grammY's raw API client, not a normal Telegram-side failure.
- **Practical consequence:** when Telegram responds with `429 Too Many Requests`, the caller of `ctx.reply(...)` (or whatever triggered the call) *does* see the rejection eventually (via the promise-adoption path above) — but nothing in `Broker`/`Planner` reacts to it. `Planner.ban()` is not called, so the bot keeps dispatching at the configured slot cadence as if nothing happened, relying purely on Telegram re-rejecting subsequent calls rather than backing off proactively. Similarly, a message that fails is **not** requeued — it's simply dropped from the Broker's perspective (the original caller sees the failure, but there's no automatic retry).
- Whatever code originally called `ctx.reply(...)` (or similar) is very likely not wrapped in its own `try/catch` in this codebase (none of the command handlers examined catch errors from their own `ctx.reply` calls at the top level — see Flows 5–7), so the eventual rejection surfaces the same way as any other pipeline error: an unhandled rejection that (depending on exactly where in the async chain it happens relative to grammY's own error boundaries) most likely ends up logged via `Bot.handleError` as a `critical` "Unhandled error on bot" — with no automatic retry and no rate-limit backoff ever actually having occurred despite the code structurally appearing to implement both.
- This finding is derived from static tracing of the exact Promise mechanics (verified twice), not from executing the code; it is called out as a **confirmed** finding rather than a guess because it does not depend on any external, unverifiable assumption — only on how `async`/`await`/`Promise.resolve(thenable)` behave, which is specified JS behavior.

**Config note:** `Broker`'s idle poll interval (used only when `Planner.pull()` returns `null`, i.e. the queue is empty or nothing is currently eligible) defaults to **1000ms in code** (`Config.getEnvAsInteger("BROKER_SLEEP_INTERVAL", 1000)`) but the committed `.env.dist` overrides it to **`10`** (ms) — a much more aggressive idle-poll cadence than the code's own fallback would suggest if you only read `config.ts` in isolation.

**When there *is* an eligible message, the Broker loop does not wait for it to finish** before checking for the next one — `handleMessages()`'s recursive branch (`await this.handleMessage(message); return this.handleMessages();`) resolves almost immediately per the bug above, regardless of how long the real HTTP call to Telegram takes. This means the loop's real throughput is gated purely by `SlotManager` reservations, not by network latency — which is a reasonable (if accidental) property, but it's a direct consequence of the same Promise-handling bug, not a deliberate "fire and forget" design documented anywhere in the code.

**State changes:** `SlotManager.reserveTimeout` set (both common and per-chat) on every successful `pull()`; `Planner.managers` gains one new entry the first time any given `chatId` is seen (never removed — see `docs/architecture.md` §17).

**Data store interactions:** none in this flow itself (purely in-memory).

**External calls:** the actual Telegram Bot API HTTP call, made from inside the `callback` closure via `originRaw[method](payload, signal)`.

**Error handling:** as detailed above — structurally present (`try/catch` + requeue + ban-on-429) but practically unreachable for the dominant failure mode (async rejection from the real HTTP call). The *only* errors that would reach `Broker.handleMessage`'s catch block are synchronous throws from invoking `originRaw[method]` itself.

**Side effects:** exactly one real outbound Telegram API call per dequeued message (when the queue-bypass branches aren't taken); `console.log("broker error", error)` if the (rarely reached) catch block does fire; `console.log(`Ban expires in ...`)` every 10s while a ban is active (from `Planner.logBanExpires`, itself effectively dead in practice since `Planner.ban()` is rarely if ever called per the above).

---

## 5. `/start` command → `StartConversation`

**Trigger:** a private-chat update whose text is `/start` (matched by grammY's `composer.command("start", ...)`, reached only after the full pipeline in Flow 3 — including the private-chat filter — has passed).

**Sequence:**
1. `StartCommand.handle(ctx)` — the *only* live line in this handler: `return this.startConversation.enter(ctx)`.
2. `ConversationHandler.enter(ctx)` → `ctx.conversation.enter("start")` — grammY's conversations plugin marks this chat as "inside" the `"start"` conversation (persisted via the session, same `PgsqlStorage` backend as Flow 3 step 1) and immediately begins executing `StartConversation.run()` (the function registered via `createConversation(handler.handle.bind(handler), "start")` in `Bot.setupConversations()`).
3. `StartConversation.run()`:
   - `const text = this.ctx.t("welcome", { formats: "woff, woff2, otf, ttf" })` — resolves the `welcome` key from the single Russian `.ftl` file via Fluent (locale is always `"ru"`, per Flow 3 step 8/Flow 8).
   - `await this.ctx.reply(text)` — an outbound call, goes through Flow 4's pipeline (queued, `MEDIUM` priority, subject to the private-chat `SlotManager`).
   - `const nextMessage = await this.conversation.wait()` — grammY's conversation plugin **suspends execution here** and returns control to the framework; the *next* update from this same chat (of any kind — any message) will be routed back into this exact point in `run()` instead of going through normal command dispatch, resuming with `nextMessage` bound to that update's context. This is how the pipeline "pauses" mid-conversation; state for where each conversation stack is paused is stored in the session.
   - `await nextMessage.reply(nextMessage.message?.text || "Чет не получилось...")` — echoes back whatever text the user just sent, or a **hardcoded Russian fallback string** if the incoming update has no `message.text` (e.g. a sticker, photo, or other non-text message) — this fallback completely bypasses Fluent (`ctx.t(...)`), so it doesn't respect the same i18n mechanism the rest of the conversation nominally uses, even though the mechanism only ever resolves to Russian anyway today.
   - `run()` then returns, ending the conversation for this chat.

**Conditions/branching:** the only real branch is "did the resumed update contain text or not," handled by the `||` fallback above.

**State changes:** conversation-active flag + resume point stored in the session (via the conversations plugin's own session usage) between the `reply` and the `wait()` resuming; cleared once `run()` returns.

**Data store interactions:** the same session reads/writes as any update (Flow 3 step 1), across *two* separate updates (the `/start` command itself, and the follow-up message that resumes `wait()`); plus the `users` upsert from `FillUserToContextMiddleware`, which runs independently for both of those updates (since it's a normal pipeline middleware, not conversation-aware).

**External calls:** two outbound messages (`ctx.reply(welcomeText)` and `nextMessage.reply(...)`), both routed through Flow 4.

**Error handling:** none within `run()` — any failure (e.g. `ctx.reply` ultimately rejecting per Flow 4's bug) propagates unguarded, same terminal path as any other pipeline error (Flow 3's "Error handling" section).

**Side effects:** two Telegram messages sent to the user (subject to Flow 4's queueing); note `StartCommand` also defines two private methods, `generateRandomFonts` and `sendRandomText`, which are **never called from `handle()`** — dead code left over from development/testing, not part of any live flow. (`sendRandomText` is a smaller-scale twin of `BulkMessagesCommand`'s pattern — see Flow 7 — manually pushing into `Planner` via `bot.grammy.api` directly rather than `ctx.api`.)

---

## 6. `/font_generator` command (font conversion pipeline)

**Trigger:** a private-chat update whose text is `/font_generator`.

**Sequence:**
1. `FontGeneratorCommand.handle(ctx)`:
   ```ts
   const promises: Promise<unknown>[] = [];
   for (let i = 0; i < 1; i++) {
       promises.push(this.generateRandomFonts.bind(this, ctx));
   }
   await Promise.all(promises);
   ```
   **Confirmed bug (already identified structurally in the first pass, reconfirmed here with exact runtime consequence):** `this.generateRandomFonts.bind(this, ctx)` produces a **bound function reference**, not a call — `generateRandomFonts` is never invoked. `promises` ends up containing one non-Promise function value; `Promise.all([fn])` resolves immediately (a non-thenable value in the array is treated as an already-resolved value). **The command handler does nothing observable at all** — no reply, no font conversion, no error — the user sends `/font_generator` and the bot silently does nothing in response. This is worth stating explicitly since the original architecture doc described the intended pipeline (which is real code, correctly written) without being fully explicit that, as currently wired, **it never actually runs**.
2. **What `generateRandomFonts(ctx)` *would* do, if it were ever actually called** (dead code today, but worth tracing since it's the only place the font-convertor domain logic in `docs/architecture.md` §7 is exercised at all, and the same pattern is duplicated — and *is* live — in `StartCommand.generateRandomFonts`, reachable only via that command's own equally-dead private method):
   - For each of `EOT`, `OTF`, `TTF`, `WOFF2` (four target extensions, hardcoded, always converting from one fixed source file at `tempDir/app/test-fonts/test-font.woff`):
     - `FontConvertor.convert({ originPath: woffPath, extension })`:
       - `prepare()` (idempotent, `isPrepared` flag) validates `tempDir` exists/readable/writable/is-a-directory, throwing typed errors (`InvalidPath`/`PermissionDenied`) otherwise.
       - Derives the source extension from the path; throws `FontConvertorError` if it equals the target extension (can't happen here since source is always `.woff` and targets are never `woff`).
       - Generates a random 15-character filename + target extension.
       - **`FileHelper.createDirectoriesByDate(tempDir)`** — creates `tempDir/<year>/<month 1-12>/<X>` where `<X>` comes from `dayjs().day()`. **Confirmed bug:** dayjs's `.day()` returns **day of the week** (`0`–`6`, Sunday=`0`), not day of month (that would be `.date()`). So despite the directory naming implying a `YYYY/M/D` calendar-date structure (and despite `docs/architecture.md`'s first pass describing it as such), the deepest bucket only ever takes one of 7 possible values and **cycles weekly** — files generated on, say, two different Wednesdays four weeks apart land in the same `<year>/<month>/3` directory. Because filenames within that directory are still random 15-character strings, actual filename collisions remain astronomically unlikely, but the bucketing scheme doesn't do what its name/structure suggests, and if `TEMP_DIR` cleanup were ever added keyed on this path structure, it would be keying on the wrong thing.
       - `ConvertorFactory.get(from, to)` dispatches to one of the ~20 concrete pair classes; throws `ConvertorNotFound` for any unsupported pair (notably anything involving `SVG`, which has no registered pairs despite being in `FontForge.supportedExtensions`).
       - The concrete convertor's `validate()` checks the source file exists/readable/is-a-file/has the expected extension, and that its extension-derived MIME type (via the `mime-types` package) is in the convertor's `allowedMimeTypes` list — then the same set of checks on the destination path (must **not** already exist, parent directory readable/writable/directory, correct extension).
       - `FontForge.convert(src, dist)` builds the shell command by naive string `.replace()` (no escaping) and runs it via `child_process.exec` (promisified). On failure, wraps the error via `ExecuteError.byError(error)`.
     - **`await ctx.reply(eotPath)`** (and similarly for otf/ttf/woff2 paths). **Confirmed finding:** this sends the **server-side local filesystem path string** (e.g. `/app/tmp/2026/8/1/kx8n2q1p3z7m9wq.eot`) as plain message *text* — it does **not** upload or attach the actual converted font file. A real end user receives four text messages containing paths on the bot's own server filesystem, not usable font files. `docs/architecture.md`'s first pass described this flow as "converted file sent back to the user," which this deeper trace corrects: the file itself is never transmitted, only its path.
   - Wrapped in a `try/catch` that just does `console.log(error)` — bypassing the structured `Logger` entirely (raw `console.log`, same pattern noted for `Broker.handleError`/`Planner.logBanExpires` in `docs/architecture.md` §6/§17).

**Conditions/branching:** none beyond the fixed 4-extension loop; no user input is read at all (the source font file and all four target extensions are hardcoded).

**State changes:** temp files created on disk under `tempDir/<year>/<month>/<weekday 0-6>/`; nothing in any database.

**Data store interactions:** none (font conversion is entirely filesystem + subprocess based).

**External calls:** a `fontforge` subprocess invocation per conversion (up to 4, if the code path were reachable); zero real outbound Telegram calls carrying file content (only text-path replies, and only if the dead code path were somehow reached).

**Error handling:** `try/catch` around the whole per-user sequence, but only reachable at all if `generateRandomFonts` were actually invoked — which, per the bug above, it currently is not.

**Side effects (as currently wired):** **none** — `/font_generator` is a live, registered command that silently does nothing when invoked.

---

## 7. `/bulk_messages` command (debug/load-test tool)

**Trigger:** a private-chat update whose text is `/bulk_messages`. Nothing about its registration distinguishes it from a real user-facing feature — it's discoverable via Telegram's command list (registered through the same `setMyCommands` call as `/start` and `/font_generator` in Flow 1) and requires no special permission to invoke; **any user who can start a private chat with the bot can trigger it.**

**Sequence:**
1. `BulkMessagesCommand.handle(ctx)`:
   ```ts
   const chats = [2815426, 5067823410, 858262157]; // hardcoded, presumably the developer's own test chat IDs
   for (let i = 0; i < 100000; i++) {
       for (const chatId of chats) {
           promises.push(this.sendRandomText(chatId));
       }
   }
   await Promise.all(promises);
   console.log("done");
   ```
   Unlike `FontGeneratorCommand`'s bug, `this.sendRandomText(chatId)` **is called here** (not `.bind`'d) — this loop genuinely queues **300,000** messages (`100,000 × 3` hardcoded chat IDs) as fast as the synchronous loop can run.
2. `sendRandomText(chatId)`, for each of the 300,000 calls:
   - `StringHelper.generateRandomString(1000)` — a fresh random 1000-character string per call (not reused across the 300,000 calls — 300,000 separate string-generation calls).
   - `await FileHelper.createDirectoriesByDate("/home/sardor/applications/telegram-bot/tmp")` — a **hardcoded absolute path specific to the original developer's machine**. On any other host, `FileHelper.isExist(...)` on this path will almost certainly return `false`, so this call throws `InvalidPath.isNotExist(...)` on the very first invocation — **300,000 times**, each one an unhandled rejection inside one of the 300,000 `Promise`s in the `promises` array passed to `Promise.all`. Note this directory creation result is **never used for anything** — its return value is discarded — so even where the path did exist, this call would be pure overhead (300,000 redundant filesystem checks) with no bearing on message content or delivery. This side call has no relationship to font conversion at all despite superficially resembling the pattern used in `FontConvertor`/`FontGeneratorCommand`.
   - Because `Promise.all` **rejects as soon as any one of its input promises rejects**, and the very first `sendRandomText` call to reach the `createDirectoriesByDate` throw will do so almost immediately, **`Promise.all(promises)` rejects essentially immediately in practice on any machine other than the original developer's**, well before most of the 300,000 `planner.push(...)` calls that appear later in the function body ever execute (since JS evaluates each `async` call up to its first `await`, immediately hits `await FileHelper.createDirectoriesByDate(...)`, and only calls that need to actually resolve first proceed to define `handler`/call `planner.push`). This means the practical blast radius of invoking this command on a non-original-developer host is smaller than "always pushes 300k messages" — many of the individual `sendRandomText` invocations fail at the directory-check step before ever reaching `planner.push`, though depending on Node's microtask scheduling a substantial number could still have started (and pushed to `Planner`) in the same tick before the first rejection is observed by `Promise.all`.
   - For any invocation that *does* get past the directory check (e.g. if that path happens to exist, or on the original developer's own machine): builds a `handler` closure calling `bot.grammy.api.sendMessage(chatId, randomText)` — note this uses **`bot.grammy.api`**, the bot-level singleton, **not** `ctx.api` — meaning this send is only rate-limited because it's manually routed through `planner.push({..., callback: handler, priorityOnError: PRIORITY.MEDIUM}, PRIORITY.LOW)` (see Flow 4's "Scope" note) rather than via the automatic `ctx.api` interception.
3. The overall command handler's own `try/catch` is absent — `handle()` has no `try` around `await Promise.all(promises)`; if it rejects (the near-certain outcome per above), the rejection propagates unguarded to grammY's error boundary exactly like any other pipeline error (Flow 3's terminal error path), and `console.log("done")` never executes.

**Conditions/branching:** none — three hardcoded chat IDs, unconditional loop.

**State changes:** up to 300,000 entries queued into `Planner`'s `LOW` bucket (subject to the directory-check-failure caveat above); `Planner.managers` gains up to 3 new `SlotManager` entries (one per hardcoded `chatId`, if not already present from other activity) — permanently, per the unbounded-`Map` issue in `docs/architecture.md` §6/§17.

**Data store interactions:** none directly (this command never touches Postgres itself — though the surrounding pipeline's session/user upserts still happen for the `/bulk_messages` update itself, same as any command).

**External calls:** up to 300,000 `sendMessage` calls to three specific chat IDs that are almost certainly not the invoking user's own chat — **any user who discovers and runs this command can cause the bot to attempt to spam three arbitrary, hardcoded Telegram chats with up to 300,000 messages each**, a genuinely user-triggerable abuse vector, not merely inert dead code, unlike `FontGeneratorCommand`'s bug. (Whether it actually reaches Telegram at meaningful scale depends on the directory-check failure discussed above happening on the deployed host — but that's an accident of the current hardcoded path, not a safeguard.)

**Error handling:** none meaningful — an unhandled `Promise.all` rejection is the most likely real-world outcome, terminating the whole handler early with no cleanup of whatever subset of the 300,000 sends had already been queued into `Planner` before the rejection was observed (those queued messages remain in the queue and will still be processed by `Broker` over time).

**Side effects:** as described — this is the single highest-blast-radius live code path in the entire application, registered as an ordinary, undocumented, unauthenticated bot command.

---

## 8. i18n / Fluent locale bootstrap

**Trigger:** part of `Bot.setup()` (Flow 1, step 4), runs exactly once per process lifetime, before the bot starts accepting updates.

**Sequence:**
1. `FileHelper.findFilesByExtensions(path.join(rootDir, "src", "infrastructure", "bot"), [".ftl"])` — recursively globs (via `tiny-glob`, pattern `**/*.{ftl}`) for `.ftl` files under the compiled/running `src/infrastructure/bot` tree. Currently finds exactly one file.
2. For each file path found, splits on `.` and takes the second-to-last segment as the locale (e.g. `start.conversation.locale.ru.ftl` → `["start","conversation","locale","ru","ftl"]` → index `length-2` → `"ru"`). **This is a purely filename-convention-based parser with no validation** — a file like `foo.bar.ftl` (only one `.` before the extension) would produce locale `"bar"`, and a file with no locale segment at all (e.g. `foo.ftl`) would produce `"foo"` as a bogus "locale." Not exercised today (only one, correctly-named file exists), but a real fragility if more `.ftl` files are added without following the exact `*.locale.<lang>.ftl` convention precisely.
3. Files are grouped by parsed locale; for each locale group, `fluent.addTranslation({ locales: locale, filePath: files, isDefault: true })` registers those files' keys with `@moebius/fluent`.
4. `useFluent({ fluent, defaultLocale: "ru", localeNegotiator: () => "ru" })` is installed as grammY middleware (step 8 of Flow 3's pipeline). **The negotiator ignores its `ctx` argument entirely** — no `ctx.from.language_code` check, no per-user/per-chat preference lookup — every update, from every user, resolves to `"ru"`.

**Conditions/branching:** none beyond the locale-parsing convention above.

**State changes:** none (Fluent's translation set is built once at startup and never mutated afterward).

**Data store interactions:** none.

**External calls:** none (purely local file reads).

**Error handling:** `findFilesByExtensions` throws if given an empty extensions array (not applicable here, `[".ftl"]` is hardcoded) — no other error handling; if `.ftl` file parsing ever failed (malformed Fluent syntax), that would surface as whatever `@moebius/fluent`'s `addTranslation` does on bad input, uncaught here, which would abort `Bot.setup()` and fall into `Bot.run()`'s outer catch (logged critical, bot ends up not actually running — see Flow 1).

**Side effects:** none beyond the in-memory Fluent registry.

---

## 9. Logging & request correlation (cross-cutting)

Not an independently triggered flow, but referenced by nearly every flow above — summarized once here for completeness.

**Which concrete logger backs every `@inject<Logger>(Infrastructure.Logger)` injection** is decided once, at container setup (Flow 1), based on `config.logger.default` (env `LOGGER_DEFAULT`, defaulting to `PinoLogger` in production / `ConsoleLogger` in development). Both concrete loggers filter by `levels` (env `LOGGER_LEVELS`, defaulting to `WARNING/ERROR/CRITICAL` in production or all levels in development) — a log call below the configured level is a no-op (the message is never formatted or written).

**When `PinoLogger` is active,** every property access on the injected `Logger` (it's bound as a `Proxy`, see `docs/architecture.md` §4) re-runs two things on **every single call**, not just the first: (1) it checks `asyncLocalStorage.getStore()?.get("logger")` and substitutes that request-scoped child logger in place of the shared singleton if present (i.e., inside `AsyncLocalStorageMiddleware`'s `asyncLocalStorage.run(...)` scope — see Flow 3 step 4 — every log call transparently gets the `requestId`-tagged child instead of the plain singleton); (2) it calls `target.setLevels(config.logger.levels)` again on whichever target was just selected, before forwarding the actual property access. This means a freshly-created child logger (from `PinoLogger.child()`, which does **not** inherit `levels` from its parent — `AbstractLogger`'s `levels` field defaults to `[]` on construction) still works correctly despite that, because the Proxy re-applies the configured levels on every single access before use — a real, if non-obvious, self-healing mechanism, and also a small repeated-work cost on every logged line.

**When `ConsoleLogger` is active** (the development default), `AsyncLocalStorageMiddleware` detects this (`!(logger instanceof PinoLogger)`) and skips the correlation setup entirely — every log line from every concurrently-processing update looks identical in terms of request identity; there is no way to correlate log lines to a specific update/request in this mode.
