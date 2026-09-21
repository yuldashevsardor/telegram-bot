# Bot

`Bot` (`telegram/bot/bot.ts`) wraps `grammy.Bot<Context>` and knows the Telegram layer only.
`Context` (`bot.types.ts`) is the grammY context with the session, conversation and Fluent
flavors plus `ctx.getUser()`; `FluentFlavor` (`locale.types.ts`) is our own, instead of the
flavor of the plugin ([`i18n.md`](./i18n.md)).

`Bot.setup()` assembles the pipeline strictly in this order, and an update from the runner
travels the same way, top to bottom: every step counts on what the previous ones filled in.
Every filter, middleware, conversation and command is injected into the `Bot` constructor by
a separate `@inject`, and the lists of steps 1-2, 5, 7 and 8 `Bot` builds out of those fields
itself: the order in the pipeline is the order in those lists, not the order of the bindings
in `container.ts`. `Bot` does not import the container.

1. `HasSessionKeyFilter` — the raw update arrives here. With the same `getSessionKey` that
   `session()` below gets, it drops updates without `from` or `chat`: those have no session,
   and everything below counts on one. The chain breaks without an error; below it `ctx.from`
   and `ctx.chat` are filled in. With `allowed_updates` set (see below) such updates are no
   longer requested, so a drop here is rare. It is written as a `warning` on top of the common
   `debug` of the base `Filter`: below the filter there will be no dump of the update
   ([`user.md`](./user.md)) any more, so the level is higher. The logger here has no
   `requestId` yet — `RequestContextMiddleware` stands lower ([`logging.md`](./logging.md)),
   so a dropped update cannot be found by `requestId`.
2. `IsPrivateChatFilter` — everything below works in private chats only. It stands second: it
   has no `ctx.chat` for updates without a session key either, and it writes no line of its
   own to the log — only the common `debug` of the base — so those updates have to be seen
   first by `HasSessionKeyFilter` with its `warning`. Both filters are above the session: a
   group update does have a session key, and step 4 would have created a `sessions` row for it
   before the drop ([invariant](./invariants.md)).
3. `sequentialize()` on the same `getSessionKey` as `session()` below — serializes the updates
   of one session, otherwise the concurrent runner would race on the session and on the
   check-then-act in `FillUserToContextMiddleware` ([`user.md`](./user.md)). It stands above
   `session()`: that one is not lazy — it reads the row before `next()` and writes it after
   the return, while the queue slot is released inside that very `next()`
   ([invariant](./invariants.md)). Updates without a key, which `sequentialize()` would let
   past the queue, never get here: step 1 dropped them.
4. `session()` — key `${from.id}:${chat.id}`, storage `PgsqlStorage` (table `sessions`),
   payload `{ requestCount }`. The row is read right away (`read`), and after the chain
   returns it is written back with an upsert (`write`) — if the session was read or changed;
   a new one counts as changed from the start. An error thrown below never reaches the write.
   Below this point `ctx.session` is filled in.
5. Middleware: `RequestContextMiddleware` → `TelegramCallApiMiddleware` →
   `ResponseTimeMiddleware` → `RequestLogMiddleware` → `FillUserToContextMiddleware`.
   `RequestContextMiddleware` goes first: everything logged below is written with a
   `requestId` ([`logging.md`](./logging.md)). `ResponseTimeMiddleware` writes an `info` with
   the time around `next()` without a `try/catch`, so a failed update gets no timing line.
   `RequestLogMiddleware` increments `requestCount` and dumps the whole `ctx.update` at
   `debug` ([`user.md`](./user.md)); because of the increment the session is touched on every
   update, so step 4 always writes the row back. `FillUserToContextMiddleware` catches no
   errors and leaves `ctx.getUser()` below itself ([`user.md`](./user.md)).
6. Fluent ([`i18n.md`](./i18n.md)) — below it `ctx.t` and `ctx.getFluent()` are filled in.
7. `conversations()` plus a `createConversation` for every conversation in the list in
   `Bot.setupConversations()`. An update of a chat that is inside a conversation right now
   goes to the `wait()` point and never reaches step 8: `createConversation` calls `next()`
   only if the conversation did not take the update.
8. The commands from the list in `Bot.setupCommands()`: `command.setup(composer)`, then
   `api.setMyCommands()` for every locale ([`i18n.md`](./i18n.md)) — a network call each, on
   every start. The last step: an update that matched no command does nothing further.

One update costs the database: on `sessions` — a `select` on the way in and an upsert after
the chain, if it did not fail; on `users` — 1 `select` (`existsById`) for a new user, 2
(`existsById` + `getById`) for an existing one, plus an upsert ([`user.md`](./user.md)). An
update dropped at steps 1-2 costs no query at all.

`Bot.run()` attaches `grammy.catch(handleError)` — the only interceptor of pipeline errors:
a `critical` log and nothing more, the user is answered nothing and sees no sign of the
failure. Then `run(grammy)` from `@grammyjs/runner` starts with
`runner.fetch.allowed_updates = ["message"]` (the `ALLOWED_UPDATES` constant in `bot.ts`):
commands and `conversation.wait()` in private chats feed on messages alone, while the
`getUpdates` default would drag in every other type, to which the pipeline answers with a
drop. The list enumerates update types, not the contents of a message: a file arrives as the
same `message` with a `document`, and accepting fonts does not widen the list.
This is not a security filter: the list is applied on the Telegram side, and after a change
of it the accumulated updates of the old types can still arrive — the filters stay where they
are.
`Bot.stop()` stops the runner within `BOT_GRACEFUL_SHUTDOWN_TIMEOUT`
([`application.md`](./application.md)).

`Command`, `Filter`, `Middleware` are abstract bases of the shape "`handle` +
`setup(composer)`"; `ConversationHandler` does not attach itself: a subclass implements `run`,
and its `handle` is wrapped by `createConversation()` (step 7). `Filter.setup()` breaks the
chain itself, calling `next()` only when `handle()` is true: `composer.filter()` of grammY is
no good for that — it does not drop the update, it only
hides behind the condition what is attached to the composer it returns, and both branches of
its `branch` call `next()`. While `setup()` relied on `filter()` and threw that composer away,
not a single filter of the repository cut anything off (the test
`test/telegram/filter/filter.spec.ts`).

The drop is logged by `Filter` itself: a `debug` line with the `constructor.name` of the
filter and the `update_id`. That is why `Logger` is injected into the base and not into the
subclasses: the decision to drop is taken in the base, and the trace of it stays there too —
otherwise every new filter would drop silently until its author got it a logger. A subclass
with dependencies passes the logger into `super()`; one without dependencies declares no
constructor at all. A filter keeps a line of its own when a different level or extra details
are needed: `HasSessionKeyFilter` writes a `warning` with the field that was missing.

## TelegramCallApiMiddleware

`telegram/middleware/mutation/telegram-call-api.middleware.ts` replaces `ctx.api.raw` with a
`Proxy`. A call with a payload object that carries `chat_id` turns into a `TaskQueue` task
(the key is `chat_id`, the priority `MEDIUM`, `priorityOnError: HIGH`); what happens to the
promise of the caller meanwhile is in [`outbound-queue.md`](./outbound-queue.md). Past the
queue go: a payload that is not built as a literal (the methods of grammY build nothing like
that, and sending a file goes through the queue as well), no `chat_id`, a `chat_id` that is
not a number, and the methods of `TELEGRAM_NO_GROUP_RATE_LIMIT_SET` — for group chats only.

The arguments of the call the `Proxy` passes to the original `raw` as they came. Methods
without parameters (`getMe`, `getWebhookInfo`) grammY calls without a payload, with a `signal`
alone, and the empty payload for them is supplied by the original `raw` itself (`createRawApi`
in `grammy/out/core/client.js`): one of our own, added in the replacement, would have taken
the place of the `signal` (the test
`test/telegram/middleware/mutation/telegram-call-api.middleware.spec.ts`).

grammY creates a new `Api` for every update, so the wrapper does not pile up and does not
touch `bot.grammy.api`: the code that calls it directly (`BulkMessagesCommand`) pushes its
task into the queue itself.

## Commands

`/start` is the entrance to a conversation: `StartCommand.handle` calls
`startConversation.enter(ctx)` → `ctx.conversation.enter("start")`. `StartConversation.run()`
then builds the greeting `ctx.t("start-conversation-welcome", { formats })`
([`i18n.md`](./i18n.md)), answers with it as a task through the queue
([`outbound-queue.md`](./outbound-queue.md)) and stops at `conversation.wait()`. At `wait()`
the execution is suspended; the next update of this chat resumes it — with a second full pass
of the pipeline, the `users` upsert included. The text of that update is echoed back, while a
non-text one gets `start-conversation-not-text`, a request to send text; at that point the
conversation ends. The state of the conversation the plugin keeps in the same session
([invariant](./invariants.md)), so the order of step 3 protects it as well. Nobody catches
errors inside `run()`.

`/font_generator` — a debugging conversion of a fixture into four formats
([`font-convertor.md`](./font-convertor.md)): up to four `fontforge` runs per command, and the
files stay on disk. The conversions go one after another and an answer leaves after each of
them; the first error cuts off the rest and is invisible to the user.

`/bulk_messages` ([overview](./README.md)) — 300 000 tasks for three hardcoded chat IDs,
visible in the command menu to everyone. It pushes the task into `TaskQueue` itself: it calls
`bot.grammy.api.sendMessage` directly, past the replacement of `ctx.api.raw`. Before every
push `FileHelper.createDirectoriesByDate()` is called on a path of the author's machine, so on
any other machine it never gets as far as `push()` at all: `InvalidPath`, `Promise.all`
rejects, and the `info` about the push is not written. There is no `try/catch` in the command,
and the rejection goes to `Bot.handleError`.
