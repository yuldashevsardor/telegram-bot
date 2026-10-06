# Invariants

Rules the compiler does not tie together: breaking one compiles and silently breaks behaviour.
A startup check or a test pins some of them, but such a check knows only today's places. It
will not see a new shutdown deadline or a new `child_process` call past `ProcessHelper`.
`CLAUDE.md` sends here before an edit of the places concerned.

## The bot pipeline and `Context`

- **`sequentialize()` is registered above `session()`.** `session()` is not lazy: it reads the
  row before its `next()` and writes it after the return. The queue slot is released inside that
  `next()`. So below `session()` both ends would stay outside the serialized section, and a second
  update of the same user would write its state over the first one. More than `requestCount` is
  lost: `@grammyjs/conversations` keeps the conversation step in the same session.
- **`sequentialize()` takes the `getSessionKey` key, as `session()` does.** The key is the pair
  `from.id` and `chat.id`, so the queue does not tie together updates of one user from different
  chats.
- **The queue protects the check-then-act in `FillUserToContextMiddleware` only while
  `IsPrivateChatFilter` leaves the user a single chat.** Let group chats into the pipeline, and the
  first two updates of a new user will both see `existsById() === false`. The data is not corrupted
  (upsert), but the choice between the `create` and `edit` branches becomes unreliable.
- **Filters are registered before `sequentialize()`, `session()` and the middleware.** Below them
  `RequestLogMiddleware` touches `ctx.session` without checking the key, and
  `FillUserToContextMiddleware` throws `UpdateWithoutFrom` without `ctx.from`. Move
  `HasSessionKeyFilter` lower, and an update without a session key ends in a `critical` from
  `Bot.handleError()` instead of the filter's `warning`.
- **A filter below `session()` drops the update after the write to the database.** `session()`
  reads the row on the way in and writes it on the way out, whether `ctx.session` was touched or
  not.
- **Pipeline handlers keep no update state in fields.** `Command`, `Filter`, `Middleware` and
  `ConversationHandler` live as one instance per process. Updates of different users run
  concurrently: `sequentialize()` queues only the same `chat.id` + `from.id`. A field written before
  an `await` may belong to someone else's update by the next line. So `ctx` and everything derived
  from it travel as parameters.
- **A new update type in the handlers requires an edit of `ALLOWED_UPDATES`** (`bot.ts`). A
  `callback_query` or `edited_message` handler compiles and registers. But `getUpdates` never
  returns updates of those types, and the handler is simply never called.
- **The outbox transformer is installed on `bot.grammy.api` before any update is handled.**
  grammY copies the transformers of `bot.api` into the `Api` of an update when the update comes, so
  the calls of an update handled before the install go straight to Telegram, past the limits and
  the order of the outbox ([`bot.md`](./bot.md), "The outbox transformer"). `Bot.setup()` installs
  it first; nothing checks that no update is handled before `setup()`.
- **`ctx.getUser()` exists only after `FillUserToContextMiddleware`.** Code higher up the pipeline
  or outside it (future background jobs) cannot count on the function.
- **Everything enumerable in `Context` goes into the conversation op log and into `sessions`.** On
  every `wait()` the conversations plugin clones all own enumerable properties of the context
  except `update`, `api`, `me` and `conversation`, and keeps the snapshot in the session. Functions
  it does not clone: it restores them bound to the live context. So whatever does not survive
  cloning lies in the context as a function:
  - `ctx.getUser()` ([`user.md`](./user.md)) instead of a `ctx.user` field. Everything in `User`
    is in private fields, so its clone would be `{}`.
  - `ctx.getFluent()` ([`i18n.md`](./i18n.md)) instead of a field with a Fluent instance, of which
    an empty shell would be left.

## DI and `container.ts`

- **DI registration is manual.** A new class does not appear in the pipeline until it is in
  `container.ts`, in the `shared/tokens.ts` dictionary, in the `Bot` constructor and in the list of
  its step in `bot.ts` ([`bot.md`](./bot.md)).
- **Dependencies are injected only by explicit `@inject(...)`.** Nobody emits
  `design:paramtypes`: `tsx` (esbuild) cannot, and the build has `emitDecoratorMetadata` off
  (`tsconfig.json`). So inversify assembles the constructor arguments from the `@inject` indexes
  alone, and a missed one is not always caught:
  - A gap in the middle fails the resolve ("Found unexpected missing metadata on type … at
    constructor indexes"). For a class with a token in `Tokens` that happens already in
    `make check` ([`application.md`](./application.md)).
  - **A forgotten `@inject` on the last parameter is caught by nothing.** The resolve passes, the
    parameter stays `undefined`, and the failure surfaces later, on the first access to it.

  This is the price of injecting the configuration: inversify cannot tell a forgotten `@inject` in
  the tail from a deliberate `configValue` in a default ([`application.md`](./application.md)).
  Loggers are outside the rule. `ApplicationContext` builds them with `new`, and they enter the
  container ready-made (`toConstantValue`): inversify does not construct them.
- **Do not switch `emitDecoratorMetadata` back on.** Injecting the configuration rests on it being
  off: a parameter with a default value stays outside the class dependencies only because inversify
  does not see it. With the flag on, such a parameter becomes a target, and the resolve fails with
  "No matching bindings found". That would happen to every such parameter, and only in the build:
  in dev there is no metadata anyway.

## The configuration and shutdown

- **Shutdown deadlines: the overall one > the sum of the individual ones (checked), the overall
  one < the container's `stop_grace_period` (not checked).** The deadlines themselves are in
  [`application.md`](./application.md). The check compares the values of one assembly. After a
  rebuild of the configuration ([`config.md`](./config.md)) they can drift apart: `Application`
  takes the overall deadline from the new values, while `Bot` and `OutboxRunner` stay on what they
  copied in their constructors. This is unreachable while the deadlines are set non-blank in the
  environment: the environment is stronger than the watched file.
- **A value taken by `configValue(...)` in a constructor is not changed by a rebuild.** The
  configuration is rebuilt on an edit of the watched file ([`config.md`](./config.md)). But an
  object that copied the value into a field keeps working on the old one. A value becomes "hot"
  only with an `onChange()` subscription and code that applies the new value. So after an edit
  `get("logger.level")` already returns the new threshold, while the logger, `Bot`, the `Database`
  pool and the limits of `OutboxStore` stay on the previous values. The divergence is silent, and
  the application has no `onChange()` subscriber yet.
- **A set environment variable is stronger than the watched file.** `.runtime.env` is laid under
  the `process.env` snapshot ([`config.md`](./config.md)). So only what is absent from the
  environment or declared blank there can be changed on the fly; a blank value counts on neither
  side. In the container the environment holds the whole `.env` (`env_file`), so a variable set
  non-blank there does not yield to the file. That is the price of the guarantee that neither an
  edit of the file nor its replacement takes the application away from what it was configured with
  at startup.
- **Config watching is removed by `ConfigContainer.unwatch()`.** A file poll left behind holds the
  event loop. In production `process.exit(0)` (`app.ts`) cuts it off. A test run is not cut off:
  mocha has no `--exit` (`.mocharc.json`), and it will wait for its timeout. The watching is
  removed:
  - in the application — by `Application.terminate()`;
  - in the specs — by `resetApplicationContext()`
    (`test/bootstrap/application/application-context.helper.ts`) and by the `afterEach` of the
    `ConfigFileStorage` spec.
- **`.runtime.env` must exist on the host before compose starts.** It is mounted into the
  container by file name, and Docker creates the bind mount of a missing path as a root-owned
  directory. The start then fails with `ConfigFileUnreadable`, and the directory has to be removed
  with sudo. The file is created by `DC_APP` in the `Makefile` and by `scripts/worktree-init.sh`.
  Running `docker compose` by hand, past `make`, has no such safeguard.
- **`LIMIT_*_NUMBER > 0`** (the config checks it). The outbox pull spaces the messages by
  `interval / number`, and a zero gives an infinite cooldown:
  - for a private or group limit, `next_attempt_at` of a pulled chat becomes `infinity`, which
    PostgreSQL accepts, and the chat is never pulled again;
  - for the common limit, the budget is zero: nothing is pulled, `next_send_at` stays in the past,
    and `nextPullInMs` is 0 while a chat is ready: the message source does not spin on it, but
    pulls again after every sleep of up to 1 s and on every push, for good
    ([`outbox.md`](./outbox.md), "Limits", "The message source").

## The outbox

- **An outbox transaction that changes a chat state from what it reads — the chat state, the active
  messages left — locks the chat row first and reads in a later statement**, as `OutboxStore.push()`
  and the completions do; every completion goes through the private `complete()`, and the unblocks
  lock the chat in `lockBlockedChat()`. The locking
  statement itself may read the columns of the row it locks: it gets their newest committed version,
  which is how `complete()` reads the lock token. Why, and what breaks otherwise, is in
  [`outbox.md`](./outbox.md), "The chat lock". `pull()` is the exception with a check of its own
  (same file, "Pull"). The spec lines up only `push()` against `markAsDone()` and
  `skipBlockedChat()`: a new path that changes a chat state outside `complete()` is checked by
  nothing.
- **A statement that locks the bot row (`telegram_bot_limits`) takes it before any other row lock
  and holds no other row lock while it waits**, as `OutboxStore.pull()` and `pause()` do, each in
  one statement. Otherwise the wait of a pull for the row can close a lock cycle; how is in
  [`outbox.md`](./outbox.md), "Pull". Nothing checks the order.
- **A statement that makes sure a chat row exists also locks it**, as the `ON CONFLICT DO UPDATE`
  of `OutboxStore.push()` does. The cleanup deletes an `idle` chat at any moment, so a row found
  by one statement and locked by the next may be gone in between, and messages inserted without
  their chat row are never pulled ([`outbox.md`](./outbox.md), "The chat lock"). The spec lines up
  only `push()` against the removal.
- **The lease of a pulled chat must outlast the send of its message.** Nothing extends a lease:
  `OutboxRunner` pulls one message per free slot and starts it at once, so the lease covers one
  call ([`outbox.md`](./outbox.md), "The runner"). Every chat of a pull is leased from the
  pull, so a caller that pulled several messages and sent them one call after another would need
  the lease to cover them all. A lease that ends while its message is still being sent lets the
  recovery of expired leases (`OutboxLeaseRecovery.recover()`) hand the message to
  another node, and it goes out twice; the late completion of the first node is fenced off and
  changes nothing. The start rejects a lease not above `OUTBOX_API_TIMEOUT`, the timeout of one call
  (`ConfigValuesBuilder.checkOutboxLease()`). An extension, if one is added, may extend only a lease
  that has not passed: the recovery tells its lease by the token, not by `locked_until`, and takes
  back the message of a passed lease its node has just extended ([`outbox.md`](./outbox.md), "Lease
  recovery").
- **A call is released on stop only once it has settled.** `OutboxLeaseReleaser.releaseOnStop()`
  makes the chat `ready` at once, so a call of the stopping node still on its way can reach Telegram
  after the next message of the chat, sent by another node: the order inside the chat breaks.
  `OutboxMessageProcessor` releases only from the `catch` of the call, once it has thrown; a new
  caller of the release is checked by nothing ([`outbox.md`](./outbox.md), "Release on stop").
- **`OutboxMessageSource` serves one generator: the runner of a node takes every message from
  one `stream(worker)`, so `OutboxRunner.start()` is called once.** The source keeps one sleep
  in progress (`currentSleep`), the one of the latest generator to fall asleep. With a second
  generator, a ready notification and `stop()` reach only that sleep: the other generator wakes on
  its own timer, up to the cap of 1 s later, and a sleep that ends first leaves the other one with
  nothing to cut it short. Each generator also starts a `LISTEN` of its own
  ([`outbox.md`](./outbox.md), "The message source"). Nothing checks this.
- **The retention of a `done` and of a `skipped` message must outlast `OUTBOX_RESULT_TIMEOUT` and
  `OUTBOX_LEASE_DURATION`.** A caller still waiting for a message the cleanup has deleted finds no
  row and times out as if the message were never sent, and may send it again. A late completion
  of an expired lease whose message another node has finished and the cleanup has deleted finds
  neither the chat nor the message and throws `OutboxMessageNotLeased` instead of being fenced
  ([`outbox.md`](./outbox.md), "Cleanup", "Completions"). Nothing checks the variables against
  each other.
- **The outbox goes by the database clock only.** `next_attempt_at`, `next_send_at` and
  `paused_until` are written and compared with `now()` and `clock_timestamp()` of PostgreSQL:
  `pause()` takes a duration, and `pull()` answers with a duration, not a moment
  ([`outbox.md`](./outbox.md), "Limits"). A moment taken from the clock of a node compares with
  `now()` through the skew of the two clocks: a pause written by a node whose clock is behind ends
  early for every node, and the next call gets a 429 again. Nothing checks this; a `Date` passed
  into the outbox SQL compiles.
- **A transaction that moves an outbox message into `done`, `failed` or `skipped` calls
  `OutboxStore.notifyFinished()` with its `sql`**, as `finishMessage()` does for `markAsDone()`,
  `markAsFailed()` and `markAsFailedAndBlockChat()`, and `skipBlockedChat()` itself. Without the
  notification a caller waiting on another node learns the outcome only from the poll, up to
  `OUTBOX_RESULT_POLL_INTERVAL` later ([`outbox.md`](./outbox.md), "Waiting for the result"). A
  new path to a final status that skips `finishMessage()` is checked by nothing.
- **`status` and `state` of the outbox tables are written only through `OutboxStatus` and
  `OutboxChatState`.** The database has no check on them: a mistyped value is stored, and the row
  or the chat silently drops out of every query.
- **Only a serializable payload enters the outbox; a file goes in only as a `PathFile`.** An
  `InputFile` from a `Buffer` or a stream compiles, as does a path passed to `new InputFile()`, and
  fails only at runtime: `serialize()` rejects it on the node that queues the call
  ([`outbox.md`](./outbox.md)).
- **The path of a `PathFile` must be on storage visible to every sending node.** Any node
  may claim the row, and it reads the file at the stored path. A path on the local disk of the
  node that queued it sends from that node and fails on every other one, at once: the file is
  missing there, and a missing file fails the message and blocks its chat with no retry
  ([`outbox.md`](./outbox.md), "Error classes"). The code does not check this; it only rejects a
  relative path (`RelativeFilePath`), which each node would resolve against its own working
  directory.
- **The file of a `PathFile` belongs to its message.** `OutboxMessageProcessor` removes it once
  the message is `done` ([`outbox.md`](./outbox.md), "Sending"), so two messages that share a path
  lose the file with the first one sent: the second fails on the missing file and blocks its chat.
  A caller that sends one file twice gives each message a copy of its own. Nothing checks this.

## The inbox

- **`status` and `state` of the inbox tables are written only through `InboxStatus` and
  `InboxGroupState`**, as those of the outbox tables are (above), and for the same reason: an
  update or a group with a mistyped value silently drops out of every query
  ([`inbox.md`](./inbox.md)).
- **`InboxStore.pushBatch()` and every completion lock the group row before they read what their
  change depends on**, as the push and the completions of the outbox lock the chat row (above);
  every completion goes through the private `complete()`, and the unblocks lock the group in
  `lockBlockedGroup()`. Read before the lock, a completion leaves
  a group `idle` with an update pushed meanwhile, an update never claimed. `claim()` is the
  exception with a check of its own ([`inbox.md`](./inbox.md), "Claim"). The spec pins a push and
  `markAsDone()`, and a push and `skipBlockedGroup()`, in both orders (same file, "Push"); a new
  write path is checked by nothing.
- **The lease of a claimed group must outlast the handling of its update, unless the lease is
  extended.** A lease that ends while the handler still runs lets the recovery of expired leases
  (`InboxFailureHandler.recoverExpiredLeases()`) give the update back to `pending`: another node
  handles it a second time, and the next update of the group may be handled while the first
  handler still runs, out of order. On the last attempt of `INBOX_MAX_ATTEMPTS` the recovery fails
  the update and blocks the group instead: a slow handler that did reply leaves its update `failed`
  and its group blocked until it is unblocked by hand. The late completion of the first node is
  fenced off and changes nothing. Nothing bounds how long a handler runs, and nothing checks
  `INBOX_LEASE_DURATION` against it. `InboxStore.extendLease()` extends only a lease that has not
  passed: the recovery tells its lease by the token, not by `locked_until`
  ([`inbox.md`](./inbox.md), "Lease recovery"). A write that moves `locked_until` without that
  check, or an extension sent as the lease passes, lets the recovery take back an update whose
  handler still runs ([`inbox.md`](./inbox.md), "The lease"). `InboxUpdateProcessor` extends every
  third of the lease, timed from the end of the previous extension, and stops at the first refusal
  ([`inbox.md`](./inbox.md), "The update processor"); a slow extension query eats into that margin,
  and nothing bounds it.
- **An update is released on stop only once its handler has settled.**
  `InboxLeaseReleaser.releaseOnStop()` makes the group `ready` at once, so a handler of the stopping
  node still running can reply after another node has handled the next update of the group: the
  order inside the group breaks. `InboxUpdateProcessor` releases only an update whose handler has
  not started or has thrown; a new caller of the release is checked by nothing
  ([`inbox.md`](./inbox.md), "Release on stop").
- **`InboxUpdateSource` serves one generator: the runner of a node takes every update from one
  `stream(worker)`, so `InboxRunner.start()` is called once**, for the reason the outbox source
  gives (above): one sleep in progress, and a `LISTEN` per generator
  ([`inbox.md`](./inbox.md), "The update source"). Nothing checks this.
- **`InboxUpdateSource` claims one update at a time.** At the stop `InboxRunner` starts the one
  update the generator has handed out and closes the generator, so whatever a claim got beyond it is
  dropped and stays claimed by the stopping node until its lease of `INBOX_LEASE_DURATION` passes
  ([`inbox.md`](./inbox.md), "The runner"). Nothing checks `CLAIM_LIMIT` against this.

## Storage: migrations, `sessions`, `User`

- **Migrations are append-only.** `node-pg-migrate` tracks the applied ones by file name. Editing
  an old file makes fresh databases diverge from existing ones.
- **The column order of `sessions`** is tied to the positional `INSERT` in `PgsqlStorage.write()`.
  A column inserted before `value` is caught by `test/telegram/session/pgsql-storage.spec.ts`: the
  specs run on a database built by the migrations, and what was written stops reading back.
- **A new user field from `ctx.from` requires a synchronous edit of:**
  - `user.types.ts`, both `Pick`s in `service/user-service.types.ts` and `user.ts`;
  - a migration;
  - `UserRow` in `pgsql-user-repository.types.ts`, the mappers and the `UPDATE SET` column list in
    `pgsql-user-repository.ts`;
  - the branches in `UserService.create()`/`edit()`;
  - both literals in `fill-user-to-context.middleware.ts`.

  A forgotten migration shows up as an SQL error at runtime. Everything that goes through
  `EditUserDto` (`Partial<Pick<...>>`) is silent: its `Pick`, the `edit()` literal in the
  middleware, the branch in `edit()`, and the `UPDATE SET` column list. The field is then written
  on creation and never updated.

## Locales

- **The part of an `.ftl` name before the extension is a locale from `LOCALES`**
  (`localeFromFilePath()`), and every locale has at least one file. Otherwise the start fails with
  `UnknownLocale` or `MissingLocaleBundle` ([`i18n.md`](./i18n.md)). The files are named
  `*.locale.<lang>.ftl` by convention; the code does not check the `.locale.` part.
- **The keys of one locale share one namespace**, so a key name includes the module that owns it
  ([`i18n.md`](./i18n.md)).

## The convertor and external processes

- **`Convertor.validateToPath()` requires a path that does not exist.** Conversion is not
  idempotent by path: the name is generated anew on every call.
- **EOT is not handed to the engine.** `fontforge` does not know the `.eot` extension. On reading
  it fails. On writing it silently falls back to PostScript Type 1: a zero exit code, a file with
  the `.eot` extension and foreign content inside, plus an `.afm` sidecar next to it. Putting
  `Extension.EOT` back into `FontForge.supportedExtensions` brings this silent corruption back.
- **External processes run only through `ProcessHelper.run()`**, with the arguments as an array.
  `exec` and any command assembled as a string bring `/bin/sh` back into the chain, and a
  substituted path becomes code again. Tests pin `ProcessHelper` itself against a swap to `exec`.
  But neither the linter nor the tests catch a new `child_process` call past it: on "normal" paths
  `exec` and `execFile` are indistinguishable.
- **`test/mutation-run.ts` calls `spawn` past `ProcessHelper` on purpose.** `ProcessHelper`
  collects the output and treats a non-zero code as a refusal. The run needs live output and a
  non-zero code as a regular outcome ([`testing.md`](./testing.md), "The run record"). The command
  is not assembled as a string there either.
