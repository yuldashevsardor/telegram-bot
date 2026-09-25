# Bot

`Bot` (`telegram/bot/bot.ts`) wraps `grammy.Bot<Context>` and knows only the Telegram layer.
`Context` (`bot.types.ts`) is the grammY context with the session, conversation and Fluent
flavors, plus `ctx.getUser()`. `FluentFlavor` (`locale.types.ts`) is our own, not the flavor of
the plugin ([`i18n.md`](./i18n.md)).

`Bot.setup()` assembles the pipeline strictly in the order below. An update from the runner
travels it top to bottom, and every step counts on what the steps above filled in. Every filter,
middleware, conversation and command comes into the `Bot` constructor by a separate `@inject`.
`Bot` builds the lists of steps 1-2, 5, 7 and 8 out of those fields itself, so the order in the
pipeline is the order in those lists, not the order of the bindings in `container.ts`. `Bot` does
not import the container.

1. `HasSessionKeyFilter` gets the raw update. It drops updates without `from` or `chat`: they
   have no session, and everything below counts on one. It decides with the same `getSessionKey`
   that `session()` gets at step 4. The chain breaks without an error. Below the filter
   `ctx.from` and `ctx.chat` are filled in.

   The drop is rare: with `allowed_updates` set (see below) such updates are no longer requested.
   The filter logs a `warning` on top of the common `debug` of the base `Filter`. The level is
   higher because below the filter there will be no dump of the update ([`user.md`](./user.md)).
   The line has no `requestId`, since `RequestContextMiddleware` stands lower
   ([`logging.md`](./logging.md)), so a dropped update cannot be found by `requestId`.
2. `IsPrivateChatFilter`: everything below works in private chats only. It stands second. It
   would drop an update without a session key as well, but it logs no line of its own, only the
   common `debug` of the base. So such updates must meet `HasSessionKeyFilter` and its `warning`
   first. Both filters stand above the session: a group update does have a session key, and
   step 4 would create a `sessions` row for it before the drop ([invariant](./invariants.md)).
3. `sequentialize()`, on the same `getSessionKey` as `session()`, serializes the updates of one
   session. Without it the concurrent runner would race on the session and on the check-then-act
   in `FillUserToContextMiddleware` ([`user.md`](./user.md)). It stands above `session()`:
   `session()` is not lazy, it reads the row before its `next()` and writes it after the return,
   while the queue slot is released inside that `next()` ([invariant](./invariants.md)).
   `sequentialize()` would let updates without a key past the queue, but they never get here:
   step 1 dropped them.
4. `session()`: the key is `${from.id}:${chat.id}`, the storage `PgsqlStorage` (table
   `sessions`), the payload `{ requestCount }`. It reads the row right away (`read`). After the
   chain returns, it writes the row back with an upsert (`write`) if the session was read or
   changed. A new session counts as changed from the start. An error thrown below never reaches
   the write. Below this step `ctx.session` is filled in.
5. Middleware: `RequestContextMiddleware` → `TelegramCallApiMiddleware` →
   `ResponseTimeMiddleware` → `RequestLogMiddleware` → `FillUserToContextMiddleware`.
   - `RequestContextMiddleware` goes first, so everything logged below carries a `requestId`
     ([`logging.md`](./logging.md)).
   - `ResponseTimeMiddleware` logs an `info` with the time around `next()`. It has no
     `try/catch`, so a failed update gets no timing line.
   - `RequestLogMiddleware` increments `requestCount` and dumps the whole `ctx.update` at
     `debug` ([`user.md`](./user.md)). The increment touches the session on every update, so
     step 4 always writes the row back.
   - `FillUserToContextMiddleware` catches no errors. Below it `ctx.getUser()` is filled in
     ([`user.md`](./user.md)).
6. Fluent ([`i18n.md`](./i18n.md)). Below it `ctx.t` and `ctx.getFluent()` are filled in.
7. `conversations()`, plus a `createConversation` for every conversation in the list of
   `Bot.setupConversations()`. An update of a chat that is inside a conversation goes to its
   `wait()` point and never reaches step 8: `createConversation` calls `next()` only when the
   conversation did not take the update.
8. The commands from the list of `Bot.setupCommands()`: `command.setup(composer)` for each, then
   `api.setMyCommands()` for every locale ([`i18n.md`](./i18n.md)). That is a network call per
   locale on every start. This is the last step: an update that matched no command goes nowhere
   further.

One update costs the database:

- on `sessions`, a `select` on the way in and an upsert after the chain, if it did not fail;
- on `users`, one `select` (`existsById`) for a new user or two (`existsById` + `getById`) for an
  existing one, plus an upsert ([`user.md`](./user.md)).

An update dropped at steps 1-2 costs no query at all.

`Bot.run()` attaches `grammy.catch(handleError)`, the only interceptor of pipeline errors. It logs
a `critical` and nothing more: the user gets no answer and sees no sign of the failure.

Then `Bot.run()` starts `run(grammy)` from `@grammyjs/runner` with
`runner.fetch.allowed_updates = ["message"]` (the `ALLOWED_UPDATES` constant in `bot.ts`).
Commands and `conversation.wait()` in private chats need messages alone. The `getUpdates` default
would also bring every type the bot does not serve. Each of those costs the network, and one that
passes the filters also costs the `sessions` read and write, the middleware and a `users` write.
The list names update types, not the contents of a message: a file arrives as the same `message`
with a `document`, so accepting fonts does not widen the list.

The list is not a security filter, so the filters stay where they are. Telegram applies the list
on its side, and after the list changes, updates of the old types accumulated before can still
arrive.

`Bot.stop()` stops the runner within `BOT_GRACEFUL_SHUTDOWN_TIMEOUT`
([`application.md`](./application.md)).

`Command`, `Filter` and `Middleware` are abstract bases of the shape "`handle` +
`setup(composer)`". `ConversationHandler` does not attach itself: a subclass implements `run`, and
`createConversation()` wraps its `handle` (step 7).

`Filter.setup()` breaks the chain itself: it calls `next()` only when `handle()` is true.
`composer.filter()` of grammY cannot do that. It does not drop the update: it only puts the
condition in front of what is attached to the composer it returns, and both branches of its
`branch` call `next()`. While `setup()` relied on `filter()` and threw that composer away, not a
single filter of the repository cut anything off (the test `test/telegram/filter/filter.spec.ts`).

`Filter` logs the drop itself: a `debug` line with the `constructor.name` of the filter and the
`update_id`. That is why `Logger` is injected into the base and not into the subclasses. The base
takes the decision to drop, so the trace of it stays there too. Otherwise every new filter would
drop silently until its author gave it a logger. A subclass with dependencies passes the logger
into `super()`; one without dependencies declares no constructor at all. A filter adds a line of
its own when it needs a different level or extra details: `HasSessionKeyFilter` logs a `warning`
with the field that was missing.

## TelegramCallApiMiddleware

`telegram/middleware/mutation/telegram-call-api.middleware.ts` replaces `ctx.api.raw` with a
`Proxy`. A call whose payload object carries `chat_id` becomes a `TaskQueue` task: the key is
`chat_id`, the priority `MEDIUM`, `priorityOnError: HIGH`. What happens to the promise of the
caller meanwhile is in [`outbound-queue.md`](./outbound-queue.md).

These calls go past the queue:

- a payload that is not built as a literal (the methods of grammY build nothing else, and
  sending a file goes through the queue as well);
- a payload without `chat_id`;
- a `chat_id` that is not a number;
- the methods of `TELEGRAM_NO_GROUP_RATE_LIMIT_SET`, for group chats only.

The `Proxy` passes the arguments of the call to the original `raw` as they came. grammY calls
methods without parameters (`getMe`, `getWebhookInfo`) without a payload, with a `signal` alone.
The original `raw` supplies the empty payload for them itself (`createRawApi` in
`grammy/out/core/client.js`). A payload of our own, added in the replacement, would take the place
of the `signal` (the test `test/telegram/middleware/mutation/telegram-call-api.middleware.spec.ts`).

grammY creates a new `Api` for every update, so the wrappers do not pile up and `bot.grammy.api`
stays untouched. Code that calls it directly (`BulkMessagesCommand`) pushes its task into the
queue itself.

## Commands

`/start` is the entrance to a conversation. `StartCommand.handle` calls
`startConversation.enter(ctx)` → `ctx.conversation.enter("start")`. `StartConversation.run()` then
builds the greeting `ctx.t("start-conversation-welcome", { formats })` ([`i18n.md`](./i18n.md)).
It sends it as a task through the queue ([`outbound-queue.md`](./outbound-queue.md)) and stops at
`conversation.wait()`. At `wait()` the execution is suspended. The next update of this chat
resumes it, with a second full pass of the pipeline, the `users` upsert included. The text of that
update is echoed back; a non-text one gets `start-conversation-not-text`, a request to send text.
Then the conversation ends. The plugin keeps the state of the conversation in the same session
([invariant](./invariants.md)), so the order of step 3 protects it as well. Nobody catches errors
inside `run()`.

`/font_generator` is a debugging conversion of a fixture into four formats
([`font-convertor.md`](./font-convertor.md)). It costs up to four `fontforge` runs per command,
and the files stay on disk. The conversions go one after another, with an answer after each. The
first error cuts off the rest, and the user does not see it.

`/bulk_messages` ([overview](./README.md)) pushes 300 000 tasks for three hardcoded chat IDs. It
is visible in the command menu to everyone. It calls `bot.grammy.api.sendMessage` directly, past
the replacement of `ctx.api.raw`, so it pushes the task into `TaskQueue` itself. Before every push
it calls `FileHelper.createDirectoriesByDate()` on a path of the author's machine. On any other
machine it never gets as far as `push()`: `InvalidPath`, `Promise.all` rejects, and the `info`
about the push is not logged. The command has no `try/catch`, and the rejection goes to
`Bot.handleError`.
