# CLAUDE.md

Telegram bot (grammY + inversify DI + PostgreSQL). For full architecture and verified runtime traces, read **`docs/architecture.md`** and **`docs/flows.md`** before making non-trivial changes — both were produced by a deep line-level audit of this exact codebase and document real bugs, not just intended design. This file only covers what a session needs to act safely; it does not repeat that material.

## Project priorities

- **Font-format conservation (`src/domain/font-convertor/`) is the actual point of this project** — converting/preserving font files across as many formats as possible. Telegram (`src/infrastructure/bot/`), the `User` domain, `BulkMessagesCommand`, and the Postgres migrations exist to support that Telegram frontend; they are not independent features in their own right. Default to treating `font-convertor` correctness/coverage as the highest-value area; treat everything else as supporting infrastructure.
- **The service is being improved incrementally, one area at a time — not rewritten.** Planned areas (in no fixed order): layers/module boundaries, config, logger, the Telegram integration, migrations, dependencies, Docker, and the font-conservation logic itself. Don't propose or start a large multi-area rewrite unprompted — scope changes to what's actually being asked for in a given session.
- **Over-engineering in this codebase is real and should be named plainly, not worked around quietly.** The logger and config layers in particular carry more indirection (`Proxy`-based rebinding, service-locator property decorators reading from a global container, dual logger backends) than the app's actual single-process/single-config-source scale needs — see `docs/architecture.md` §17/§19 for specifics. When touching either, it's fine to say so and propose simplification rather than only extending the existing pattern.

## Commands

- Install deps, then `docker-compose up -d` to start local Postgres (only Postgres is containerized — the app runs on the host).
- `npm run migrate` — apply migrations (`node-pg-migrate`, config in `migrate.json`). Run this before first `npm start`.
- `npm run build` — `tsc` + `tsc-alias` (rewrites the `app/*` alias to relative paths for `build/`).
- `npm start` / `npm run start:prod` — runs `build/app.js` (note: **not** `build/src/index.js`, despite `package.json#main`).
- `npm test` — mocha over `test/**/*.spec.ts`. **There is effectively one real test in the whole repo** (`test/services/message-broker/slot-manager/slot-manager.spec.ts`, testing `SlotManager` in isolation), and `test/bootstrap.ts` (loaded by the test script) is empty. Don't treat a green `npm test` as meaningful coverage of anything you changed — verify manually.

## Architecture conventions (brief — see `docs/architecture.md` for full detail)

- **Import alias only:** every internal import uses `app/*` (→ `src/*`), never relative paths. ESLint's `no-restricted-imports` bans relative imports outright (`.eslintrc.js`) — a relative import will fail lint, not just look wrong. Migration files are the one deliberate exception.
- **DI is manual, not auto-discovered.** New `@injectable()` classes (commands, middlewares, filters, services, conversations) do nothing until you add a matching `this.bind<T>(Symbol).to(Class)` line in `src/infrastructure/container/container.ts`, plus a symbol in `src/infrastructure/container/symbols/`. Nothing will warn you if you forget — the class just silently never runs.
- **Layering:** `domain/` = business logic + ports, framework-agnostic; `infrastructure/` = adapters (Postgres, grammY, loggers, config). Keep new domain code free of `grammy`/`postgres`/`pino` imports — those belong in `infrastructure/`.
- **File naming:** kebab-case is the current convention (`fill-user-to-context.middleware.ts`); a handful of older `infrastructure` files use dot-case (`pgsql.decorator.ts`, `abstract.logger.ts`) as pre-refactor leftovers — match kebab-case for anything new, don't propagate the old style.
- **Errors:** always extend `RuntimeError` (`src/common/errors.ts`) for domain errors, with a `static byX(...)` factory following the existing pattern in `*.errors.ts` files. **Do not call the inherited `RuntimeError.byError()`** on a subclass expecting it to return an instance of that subclass — it always throws a plain `RuntimeError` from inside itself instead of returning (a real, currently-dormant bug in the base class; see `docs/architecture.md` §17). If you need subclass-typed wrapping, write the subclass's own factory instead of relying on the inherited one.

## System invariants — do not break these

- **Only private chats are processed.** `IsPrivateChatFilter` drops everything else after the middleware/session/user-upsert stage runs. If you add group-chat support, you must also revisit the group rate limits in `Planner` (they're configured but currently unreachable) and the `TELEGRAM_NO_GROUP_RATE_LIMIT_SET` whitelist in `TelegramCallApiMiddleware`, which only applies to groups.
- **`ctx.api` is a fresh object per incoming update** (grammY constructs a new `Api` instance for every update — verified against the exact locked grammY version, `1.10.1`). Never assume state you set on `ctx.api` (or its `.raw`) persists across updates, and never assume `ctx.api === bot.grammy.api` — they are different objects. Code that needs to send messages outside of handling a specific update (background jobs, bulk sends) must call through `bot.grammy.api` **and manually `planner.push(...)`** to get rate-limiting — see `BulkMessagesCommand` for the existing (if otherwise unsafe) pattern.
- **`ctx.session` throws if accessed when `ctx.from` or `ctx.chat` is missing** (e.g. channel posts) — this is grammY's own behavior given `getSessionKey`'s implementation in `session.helper.ts`, not a bug to "fix" locally without changing `getSessionKey`. Any new middleware placed before `FillUserToContextMiddleware` that touches `ctx.session` unconditionally will crash the pipeline for such updates, the same way `RequestLogMiddleware` currently does. If you need to handle from-less/chat-less updates gracefully, guard `ctx.session` access itself — don't just copy `FillUserToContextMiddleware`'s `if (!ctx.from)` pattern, since (per `docs/flows.md` Flow 3) that pattern never actually gets reached today.
- **Rate limiting is enforced entirely by `Planner`/`SlotManager`, not by `Broker`'s retry/ban logic** — the latter is very likely dead code at runtime (see `docs/flows.md` Flow 4 for the exact Promise-chain reason). Don't build new features that assume the bot backs off automatically on HTTP 429; it currently doesn't.
- **i18n is single-locale (`"ru"`) by hardcoded design** (`Bot.setupFlavor`'s `localeNegotiator`). Adding a new `.ftl` file alone does not make it reachable — you must also change the negotiator to actually select a locale per-user.
- **Migrations are append-only.** Never edit an already-applied migration file under `src/infrastructure/database/migrations/` — add a new one (`node-pg-migrate` scaffolding, template at `migrations/common/template.ts`). The existing `users.id` int→bigint migration exists specifically because an early migration got the column type wrong; don't repeat that by hand-editing history.

## Non-obvious implementation details worth knowing before you touch related code

(Full list with exact mechanics in `docs/architecture.md` §17 and `docs/flows.md`.)

- `TelegramCallApiMiddleware` intercepts outbound Telegram calls via a `Proxy` on `ctx.api.raw`, diverting anything with a plain-object `chat_id` payload into the `Planner` queue. Non-plain-object payloads (e.g. multipart file uploads) bypass the queue entirely — untested territory if you add a feature that uploads files.
- `FileHelper.createDirectoriesByDate` buckets by day-of-**week** (`dayjs().day()`), not day-of-month — a `YYYY/M/D`-looking path that isn't what it looks like. Don't rely on it for actual calendar-date bucketing without fixing the `.day()`/`.date()` mixup first.
- Generated font files are never uploaded to the user — existing code replies with the local server path as text. If you wire up real file delivery, you'll need to actually attach the file (e.g. `InputFile`), not follow the existing pattern.
- The Postgres logger Proxy (`Container.setupInfrastructureLogger`) re-applies `setLevels()` and re-resolves the request-scoped child logger on **every single property access**, not just once — this is intentional (it's how `AsyncLocalStorage`-based request correlation works) but means logger calls are not as cheap as they look.

## Handle with extra care

- **`src/infrastructure/container/container.ts`** — central, hand-maintained wiring; a missed or misordered binding fails silently (no error) rather than loudly.
- **`src/infrastructure/bot/middleware/mutation/telegram-call-api.middleware.ts`** and **`src/domain/planner/planner.ts`** / **`src/domain/broker/broker.ts`** — the rate-limiting core. Changes here affect whether the bot can get itself banned by Telegram; test manually against real rate limits, since there's no automated coverage and the existing retry logic doesn't actually run (see invariants above).
- **`src/infrastructure/bot/command/bulk-messages/bulk-messages.command.ts`** — a live, unauthenticated `/bulk_messages` command that queues up to 300,000 outbound messages to hardcoded chat IDs when invoked by *any* user. Treat as something to remove or gate behind auth, not extend. Don't take its pattern (manual `bot.grammy.api` + `planner.push`) as the template for new bulk-send features without adding real authorization first.
- **`.env.dist`** — contains a real-looking, plaintext `BOT_TOKEN`. Never commit an actual live token to this or any tracked file; treat the existing one in git history as already compromised if it's ever turned out to be real.
- **Migration files under `src/infrastructure/database/migrations/`** — append-only, see invariants above.

## Code style

- Prettier: 4-space indent, 140-char lines, double quotes, trailing commas. Enforced via Husky `pre-commit` (`lint-staged` → `eslint --fix` then `prettier --write`) — don't bypass with `--no-verify`.
- No comments explaining *what* code does; this repo's existing comment style (sparse, mostly Russian, explaining *why* for non-obvious hacks like the `TelegramCallApiMiddleware` proxy) is the right model to follow, not verbose doc comments.
