# Invariants

Rules the compiler does not tie together: breaking one compiles and breaks behaviour silently.
Some are pinned by a startup check or by a test on a specific place, but such a check knows only
today's places: it will not see a third shutdown deadline or a new `child_process` call past
`ProcessHelper`. `CLAUDE.md` sends here before an edit of the places concerned.

- **`sequentialize()` takes the `getSessionKey` key, as `session()` does, and is registered above
  `session()`.** Below `session()` the queue is useless for the session itself: `session()` is not
  lazy, it reads the row before its `next()` and writes it after the return, while the queue slot
  is released inside that `next()` — both ends would stay outside the serialized section, and a
  second update of the same user would write its state over the first one. The cost is not only
  `requestCount`: `@grammyjs/conversations` keeps the conversation step in the same session. The
  key is the pair `from.id` and `chat.id`, so the queue does not tie together updates of one user
  from different chats: the check-then-act in `FillUserToContextMiddleware` is protected only
  while `IsPrivateChatFilter` leaves the user a single chat. Let group chats into the pipeline, and
  the first two updates of a new user will both see `existsById() === false`: the data is not
  corrupted (upsert), but the choice between the `create` and `edit` branches becomes unreliable.
- **Migrations are append-only.** `node-pg-migrate` tracks the applied ones by file name; editing
  an old file makes fresh databases diverge from existing ones.
- **Pipeline handlers keep no update state in fields.** `Command`, `Filter`, `Middleware`,
  `ConversationHandler` live as one instance per process, while updates of different users run
  concurrently: `sequentialize()` queues only the same `chat.id` + `from.id`. What was written to a
  field before an `await` may belong to someone else's update by the next line, so `ctx` and
  everything derived from it travel as parameters.
- **DI registration is manual.** A new class does not appear in the pipeline until it is in
  `container.ts`, in the `shared/tokens.ts` dictionary, in the `Bot` constructor and in the list of
  its step in `bot.ts` ([`bot.md`](./bot.md)).
- **`ctx.api` versus `bot.grammy.api`.** The queue interception lives only on the `ctx.api` of the
  current update ([`bot.md`](./bot.md)). A direct call of `bot.grammy.api` bypasses the limits.
- **Filters are registered before `sequentialize()`, `session()` and the middleware.** Below them
  `ctx.session` is touched without checking the key (`RequestLogMiddleware`), and `ctx.from` is
  counted on (`FillUserToContextMiddleware` throws `UpdateWithoutFrom` without it): move
  `HasSessionKeyFilter` lower, and an update without a session key ends in a `critical` from
  `Bot.handleError()` instead of the filter's `warning`. And since `session()` is not lazy — it
  reads the row on the way in and writes it on the way out whether `ctx.session` was touched or
  not — a filter below it drops the update after the write to the database.
- **A new update type in the handlers requires an edit of `ALLOWED_UPDATES`** (`bot.ts`). A
  `callback_query` or `edited_message` handler compiles and registers, but `getUpdates` never
  returns updates of those types, and the handler is simply never called.
- **`ctx.getUser()` exists only after `FillUserToContextMiddleware`.** Code higher up the pipeline
  or outside it (future background jobs) cannot count on the function.
- **Everything enumerable in `Context` goes into the conversation op log and into `sessions`.** On
  every `wait()` the conversations plugin clones all own enumerable properties of the context
  except `update`, `api`, `me` and `conversation`, and keeps the snapshot in the session; functions
  it does not clone but restores by binding them to the live context. So everything that does not
  survive cloning lies in the context as a function: `ctx.getUser()` ([`user.md`](./user.md))
  instead of a `ctx.user` field, whose clone would be `{}` — everything in `User` is in private
  fields, and `ctx.getFluent()` ([`i18n.md`](./i18n.md)) instead of a field with a Fluent instance,
  of which an empty shell would be left.
- **Shutdown deadlines**: the overall one > the sum of the individual ones (checked), the overall
  one < the container's `stop_grace_period` (not checked); the deadlines themselves are in
  [`application.md`](./application.md). The check compares the values of one assembly, and after a
  rebuild of the configuration ([`config.md`](./config.md)) they can drift apart: `Application`
  takes the overall deadline and the queue deadline from the new values, while `Bot` stays on what
  it copied in its constructor. While the deadlines are set non-blank in the environment this is
  unreachable — the environment is stronger than the watched file.
- **A value taken by `configValue(...)` in a constructor is not changed by a rebuild.** The
  configuration is rebuilt on an edit of the watched file ([`config.md`](./config.md)), but an
  object that copied the value into a field keeps working on the old one: a value is made "hot"
  only by an `onChange()` subscription and code that applies the new value. So after an edit
  `get("logger.level")` already returns the new threshold, while the logger, `Bot`, the `Database`
  pool and the queue limits stay on the previous values — the divergence is silent, and the
  application has no `onChange()` subscriber yet.
- **A set environment variable is stronger than the watched file.** `.runtime.env` is laid under
  the `process.env` snapshot ([`config.md`](./config.md)), so only what is absent from the
  environment or declared blank there can be changed on the fly (a blank value counts on neither
  side). In the container the environment holds the whole `.env` (`env_file`), so a variable set
  non-blank there does not yield to the file — that is the price of neither an edit of the file
  nor its replacement taking the application away from what it was configured with at startup.
- **Config watching is removed by `ConfigContainer.unwatch()`.** A file poll left behind holds the
  event loop: in production `process.exit(0)` (`app.ts`) cuts it off, but a test run does not —
  mocha has no `--exit` (`.mocharc.json`), and it will wait for its timeout. In the application it
  is removed by `Application.terminate()`, in the specs by `resetApplicationContext()`
  (`test/bootstrap/application/application-context.helper.ts`) and by the `afterEach` of the
  `ConfigFileStorage` spec.
- **`.runtime.env` must exist on the host before compose starts.** It is mounted into the
  container by file name, and Docker creates the bind mount of a missing path as a root-owned
  directory: the start fails with `ConfigFileUnreadable`, and the directory then has to be removed
  with sudo. The file is created by `DC_APP` in the `Makefile` and by `scripts/worktree-init.sh`;
  running `docker compose` by hand, past `make`, has no such safeguard.
- **`LIMIT_*_NUMBER > 0`** (the config checks it). Zero → `reserveDuration = Infinity` → the slot
  is taken forever and the partition is never removed ([`outbound-queue.md`](./outbound-queue.md)).
- **A new user field from `ctx.from`** requires a synchronous edit of `user.types.ts`, both `Pick`s
  in `service/user-service.types.ts`, `user.ts`, a migration, `UserRow` in
  `pgsql-user-repository.types.ts`, the mappers and the `update set` column list in
  `pgsql-user-repository.ts`, the branches in `UserService.create()`/`edit()` and both literals in
  `fill-user-to-context.middleware.ts`. A forgotten migration shows up as an SQL error at runtime,
  while everything that goes through `EditUserDto` (`Partial<Pick<...>>`) is silent: its `Pick`,
  the `edit()` literal in the middleware, the branch in `edit()` — and the `update set` column
  list: the field is written on creation and never updated.
- **The column order of `sessions`** is tied to the positional `insert` in `PgsqlStorage.write()`.
  A column inserted before `value` is caught by `test/telegram/session/pgsql-storage.spec.ts`: the
  specs run on a database built by the migrations, and what was written stops reading back.
- **The part of an `.ftl` name before the extension is a locale from `LOCALES`**
  (`localeFromFilePath()`), and every locale has at least one file: otherwise the start fails with
  `UnknownLocale` or `MissingLocaleBundle` ([`i18n.md`](./i18n.md)). The files are named
  `*.locale.<lang>.ftl` by convention; the `.locale.` part the code does not check.
- **The keys of one locale share one namespace**, so a key name includes the module that owns it
  ([`i18n.md`](./i18n.md)).
- **`Convertor.validateToPath()` requires a path that does not exist**: conversion is not
  idempotent by path, the name is generated anew on every call.
- **EOT is not handed to the engine.** `fontforge` does not know the `.eot` extension: on reading
  it fails, and on writing it silently falls back to PostScript Type 1 — the result is a zero exit
  code, a file with the `.eot` extension and foreign content inside, plus an `.afm` sidecar next
  to it. Putting `Extension.EOT` back into `FontForge.supportedExtensions` brings this silent
  corruption back.
- **External processes only through `ProcessHelper.run()`**, with the arguments as an array.
  `exec` and any command assembled as a string bring `/bin/sh` back into the chain, and a
  substituted path becomes code again. `ProcessHelper` itself is pinned against a swap to `exec` by
  tests, but a new `child_process` call past it is caught by neither the linter nor the tests: on
  "normal" paths `exec` and `execFile` are indistinguishable. The `test/mutation-record.ts` wrapper
  calls `spawn` past `ProcessHelper` on purpose: that one needs collected output and a non-zero
  code as a refusal, while the run needs live output and a non-zero code as a regular outcome
  ([`testing.md`](./testing.md), "The run record"). The command is not assembled as a string there
  either.
- **Dependencies are injected only by explicit `@inject(...)`.** Nobody emits
  `design:paramtypes`: `tsx` (esbuild) cannot, and the build has `emitDecoratorMetadata` off
  (`tsconfig.json`). So inversify assembles the constructor arguments from the `@inject` indexes
  alone, and a miss is not caught everywhere: a gap in the middle fails the resolve ("Found
  unexpected missing metadata on type … at constructor indexes") — for a class with a token in
  `Tokens` already in `make check` ([`application.md`](./application.md)), while **a forgotten
  `@inject` on the last parameter is caught by nothing** — the resolve passes, the parameter stays
  `undefined`, and the failure surfaces later, on the first access to it. This is the price of
  injecting the configuration: inversify cannot tell a forgotten `@inject` in the tail from a
  deliberate `configValue` in a default ([`application.md`](./application.md)). Loggers are outside
  the rule: `ApplicationContext` builds them with `new`, and they enter the container ready-made
  (`toConstantValue`), inversify does not construct them.
- **Do not switch `emitDecoratorMetadata` back on.** Injecting the configuration rests on it being
  off: a parameter with a default value stays outside the class dependencies only because inversify
  does not see it. With the flag on it becomes a target and the resolve fails with "No matching
  bindings found" — that is, every such parameter would fail, and only in the build, because in dev
  there is no metadata anyway.
- **`Runner.run()`/`stop()` are synchronous**; `stop()` only lowers a flag and does not wait for a
  task the loop has already taken: `handleTasks()` does not await its call to Telegram.
