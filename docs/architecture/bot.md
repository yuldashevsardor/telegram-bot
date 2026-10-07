# Bot

`Bot` (`telegram/bot/bot.ts`) wraps `grammy.Bot<Context>` and knows only the Telegram layer.
`Context` (`bot.types.ts`) is the grammY context with the session, conversation and Fluent
flavors, plus `ctx.getUser()`. `FluentFlavor` (`locale.types.ts`) is our own, not the flavor of
the plugin ([`i18n.md`](./i18n.md)).

`Bot.setup()` first installs the outbox transformer on `bot.grammy.api` (see "The outbox
transformer"), then assembles the pipeline strictly in the order below. An update from the runner
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
5. Middleware: `RequestContextMiddleware` → `ResponseTimeMiddleware` → `RequestLogMiddleware` →
   `FillUserToContextMiddleware`.
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

- on `sessions`, a `SELECT` on the way in and an upsert after the chain, if it did not fail;
- on `users`, one `SELECT` (`existsById`) for a new user or two (`existsById` + `getById`) for an
  existing one, plus an upsert ([`user.md`](./user.md));
- on the outbox, for every call to a chat a handler makes, the transaction of the push and the
  lookups of the wait ([`outbox.md`](./outbox.md), "Push", "Waiting for the result").

An update dropped at steps 1-2 costs no query at all.

`Bot.run()` attaches `grammy.catch(handleError)`, the only interceptor of pipeline errors. It logs
a `critical` and nothing more: the user gets no answer and sees no sign of the failure.

Then `Bot.run()` starts `run(grammy)` from `@grammyjs/runner` with
`runner.fetch.allowed_updates = ["message"]` (the `ALLOWED_UPDATES` constant in `bot.types.ts`).
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

## The outbox transformer

`OutboxTransformer` (`telegram/outbox/transformer/outbox-transformer.ts`) is a grammY API
transformer on `bot.grammy.api`. grammY gives every update an `Api` of its own with the
transformers of `bot.api` copied into it (`handleUpdate()` in grammY's `bot.js`), so the calls of
`ctx.api` and of `bot.grammy.api` go through the same transformer, a call made outside an update
included. The copy is taken when the update comes, so the transformer is installed before any
update is handled ([invariant](./invariants.md)).

A call to a chat becomes an outbox message ([`outbox.md`](./outbox.md)), and the caller gets its
outcome:

1. `serialize()` stores the payload ([`outbox.md`](./outbox.md), "The payload rule"). A payload the
   codec refuses rejects the call, and nothing is pushed.
2. `OutboxStore.push()` with the `chat_id` as the chat and `OutboxPriority.Call`.
3. `OutboxResultWaiter.wait()` for the outcome of the message.
4. The outcome becomes the answer grammY expects of the network, so grammY settles the call as one
   it sent itself:
   - `done` gives the stored response as the result: `ctx.reply()` resolves to the `Message`;
   - `failed` with the answer of Telegram in its last attempt gives that answer back with
     `ok: false`, and grammY throws a `GrammyError`, whatever failed the message: a chat that cannot
     get the message (403, `chat not found`) fails it without blocking the chat
     ([`outbox.md`](./outbox.md), "Error classes"), and a 5xx on the last of its retries fails it
     with the 5xx;
   - `failed` without such an answer (an `HttpError` on the last of its retries, a lease that
     expired on the last attempt, a row that did not rebuild) throws `OutboxMessageFailed` with
     the error of the attempt;
   - `skipped` throws `OutboxMessageSkipped`.

The wait ends with `OutboxResultTimeout` after `OUTBOX_RESULT_TIMEOUT`, and the message stays
queued and may still go out. That is what every call to a chat that a failed message has blocked
ends in: the call is pushed behind the blocked head, which holds the chat until it is unblocked by
hand ([`outbox.md`](./outbox.md), "Tables"). The signal of the caller does not reach a queued
call: the runner sends the message with a signal of its own.

These calls go straight to Telegram, past the outbox:

- a payload that is not a plain object: a raw call without arguments (`api.raw.getMe()`) or a
  payload built by a class (the methods of grammY build object literals);
- a payload without `chat_id`. That covers the service calls of the bot (`getMe`,
  `setMyCommands`, `getUpdates`, `setWebhook`, ...): none of them names a chat, so no list of
  them is kept;
- a `chat_id` that is not a number, a chat named by its username (`@channel`);
- the methods of `OutboxTransformer.GROUP_METHODS_PAST_THE_OUTBOX` for a group chat: Telegram
  does not count them towards the limit of the group.

`@grammyjs/conversations` installs a transformer of its own on the `Api` of the update, around
this one. While it replays a conversation it answers each call from its log and does not call the
transformer below it, so a replayed `ctx.reply()` is not pushed again (the test in
`test/telegram/bot.spec.ts`). Its log keeps the result the call got the first time, which is why
the transformer resolves the call to the real `Message` rather than at the push.

A handler that awaits a call to a chat waits for the pull of its message, the limits of the chat
and of the bot, and the send.

## Commands

`/start` is the entrance to a conversation. `StartCommand.handle` calls
`startConversation.enter(ctx)` → `ctx.conversation.enter("start")`. `StartConversation.run()` then
builds the greeting `ctx.t("start-conversation-welcome", { formats })` ([`i18n.md`](./i18n.md)).
It sends it with `ctx.reply()` through the outbox (see "The outbox transformer") and stops at
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

`/bulk_messages` ([overview](./README.md)) pushes 10 000 `sendMessage` calls of a random text
for three hardcoded chat IDs, the chats in turn. It is visible in the command menu to everyone. It
pushes them straight into `OutboxStore.pushBatch()`, past the transformer, so that they get
`OutboxPriority.Bulk`, and it waits for none of them to be sent. The priority orders the chats, not
the messages of a chat: the three chats yield to the chats with calls of the bot, while a reply in
one of them waits for the bulk messages pushed into it before. The
batches are of 1000: one batch is one transaction with its messages in one `jsonb` parameter. The
command has no `try/catch`: a batch that fails rejects it, the rejection goes to
`Bot.handleError`, and the batches pushed before it stay queued. The rows outlive the process: for a
chat the bot cannot reach every message fails without blocking the chat, and nothing deletes a
`failed` row ([`outbox.md`](./outbox.md), "Cleanup"), so each run leaves its share of the 10 000
rows behind.
