# Bot

`Bot` (`telegram/bot/bot.ts`) wraps `grammy.Bot<Context>` and knows only the Telegram layer.
`Context` (`bot.types.ts`) is the grammY context with the session and Fluent
flavors, plus `ctx.getUser()`. `FluentFlavor` (`locale.types.ts`) is our own, not the flavor of
the plugin ([`i18n.md`](./i18n.md)).

`Bot.setup()` first installs the outbox transformer on `bot.grammy.api` (see "The outbox
transformer"), then assembles the pipeline strictly in the order below. An update from the inbox
travels it top to bottom, and every step counts on what the steps above filled in. Every filter,
middleware and command comes into the `Bot` constructor by a separate `@inject`. `Bot` builds the
lists of steps 1-2, 4, 6 and 7 out of those fields itself, so the order in the pipeline is the
order in those lists, not the order of the bindings in `container.ts`. `Bot` does not import the
container.

1. `HasSessionKeyFilter` gets the raw update. It drops updates without `from` or `chat`: they
   have no session, and everything below counts on one. It decides with the same `getSessionKey`
   that `session()` gets at step 3. The chain breaks without an error. Below the filter
   `ctx.from` and `ctx.chat` are filled in.

   The drop does not happen today: with `allowed_updates` set (see below) such updates are not
   requested, and the polling source drops one before it reaches the inbox
   ([`inbox.md`](./inbox.md), "Updates without a session key").
   The filter logs a `warning` on top of the common `debug` of the base `Filter`. The level is
   higher because below the filter there will be no dump of the update (step 4).
   The line has no `requestId`, since `RequestContextMiddleware` stands lower
   ([`logging.md`](./logging.md)), so a dropped update cannot be found by `requestId`.
2. `IsPrivateChatFilter`: everything below works in private chats only. It stands second. It
   would drop an update without a session key as well, but it logs no line of its own, only the
   common `debug` of the base. So such updates must meet `HasSessionKeyFilter` and its `warning`
   first. Both filters stand above the session: a group update does have a session key, and
   step 3 would create a `sessions` row for it before the drop ([invariant](./invariants.md)).
3. `session()`: the key is `${from.id}:${chat.id}`, the storage `PgsqlStorage` (table
   `sessions`), the payload `SessionPayload` (`session.types.ts`). It reads the row right away
   (`read`). After the chain returns, it writes the row back with an upsert (`write`) if the
   session was read or changed. A new session counts as changed from the start. An error thrown
   below never reaches the write. Below this step `ctx.session` is filled in.

   A row written while the former `/start` conversation waited still holds a `conversation`
   field, the state of `@grammyjs/conversations`, which the bot no longer installs. Nothing reads
   the field, and the upsert writes it back with the rest of the payload.

   Nothing in the pipeline serializes the updates of one session: the read and the write wrap the
   whole chain, so two updates of a session running at once would lose the first one's state. The
   inbox is what prevents it: it hands out one update of a group, the same key, at a time across
   nodes ([`inbox.md`](./inbox.md); [invariant](./invariants.md)).
4. Middleware, the first call of `Bot.setupMiddlewares()`: `RequestContextMiddleware` →
   `ResponseTimeMiddleware` → `RequestLogMiddleware` → `FillUserToContextMiddleware`.
   - `RequestContextMiddleware` goes first, so everything logged below carries a `requestId`
     ([`logging.md`](./logging.md)).
   - `ResponseTimeMiddleware` logs an `info` with the time around `next()`. It has no
     `try/catch`, so a failed update gets no timing line.
   - `RequestLogMiddleware` increments `requestCount`, which nothing reads, and dumps the whole
     `ctx.update` at `debug`. The increment touches the session on every update, so step 3 always
     writes the row back.
   - `FillUserToContextMiddleware` catches no errors. Below it `ctx.getUser()` is filled in
     ([`user.md`](./user.md)).
5. Fluent ([`i18n.md`](./i18n.md)). Below it `ctx.t` and `ctx.getFluent()` are filled in. Right
   after it `Bot.setupDescriptions()` sets the descriptions of the bot (see "Commands"), which add
   nothing to the pipeline.
6. The commands from the list of `Bot.setupCommands()`: `command.setup(composer)` for each, then
   the menus with `api.setMyCommands()` (see "Commands"). With the descriptions of step 5 that is,
   on every start and one after another, two calls per locale for the descriptions and one call per
   locale for each menu: the common one and one per chat of `/bulk_messages`. An update that
   matched no command goes on to step 7.
7. What no command took: a second call of `Bot.setupMiddlewares()`, below the commands, with
   `UnknownCommandMiddleware` → `NotAFileMiddleware` → `FileIntakeMiddleware` →
   `ConversionMiddleware` (see "Commands"). The first three take messages alone, so a press of a
   button passes them on to the conversion. This is the last step: a message without content and a
   press of a button that is not a format button pass all four, and nothing takes them further.

One update costs the database:

- on `sessions`, a `SELECT` on the way in and an upsert after the chain, if it did not fail;
- on `users`, one `SELECT` (`existsById`) for a new user or two (`existsById` + `getById`) for an
  existing one, plus an upsert ([`user.md`](./user.md));
- on the outbox, for every call to a chat a handler makes, the transaction of the push and the
  lookups of the wait ([`outbox.md`](./outbox.md), "Push", "Waiting for the result").

An update dropped at steps 1-2 costs no query at all.

`Bot` neither polls nor runs anything. `InboxPollingSource` takes the updates from Telegram into
the inbox, and `InboxUpdateProcessor` hands each one to `bot.grammy.handleUpdate()`
([`inbox.md`](./inbox.md), "The polling source", "The update processor"); `Application` starts and
stops both ([`application.md`](./application.md)). `handleUpdate()` wraps an error of the pipeline
into a `BotError` and throws it on, so no `bot.catch()` is set: the inbox picks the outcome of the
update by the class of the error ([`inbox.md`](./inbox.md), "Failures"). Only an update that blocks
its group gets an answer, sent from the inbox and not from the pipeline ([`inbox.md`](./inbox.md),
"The answer to the sender"); a failure that does not block shows the user no sign of itself. The
inbox logs none either, except for a blocked group: the failures that do not block are seen in the
`attempts` of the inbox tables, and a 413 also in the error the outbox logs for it
([`inbox.md`](./inbox.md), "Outcomes"; [`outbox.md`](./outbox.md), "Error classes").

The polling source asks only for `ALLOWED_UPDATES` of `bot.types.ts`,
`["message", "callback_query"]`. Commands and the answers of step 7 in private chats need messages,
and the conversion needs the presses of the format buttons, which come as `callback_query`. The
`getUpdates` default would also bring every type the bot does not serve. Each of those costs the
network, and one that passes the filters also costs the `sessions` read and write, the middleware
and a `users` write.
The list names update types, not the contents of a message: a file arrives as the same `message`
with a `document`, so accepting fonts does not widen the list.

A press carries the message its button stands under, the question of the bot, so `ctx.chat` of a
press is the chat of that question, and `ctx.from` the person who pressed. The filters of steps 1-2
and the session key read them as they read those of a message: a press in a private chat goes down
the pipeline, and one in a group is dropped above the session. A button of a message sent in
inline mode would come without the message and its chat, but the bot sends none: it answers no
inline query, `inline_query` is not in the list.

The list is not a security filter, so the filters stay where they are. Telegram applies the list
on its side, and after the list changes, updates of the old types accumulated before can still
arrive.

`Command`, `Filter` and `Middleware` are abstract bases of the shape "`handle` +
`setup(composer)`".

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
ends in: the failed message holds the chat until it is unblocked by hand
([`outbox.md`](./outbox.md), "Tables"). The signal of the caller does not reach a queued call: the
runner sends the message with a signal of its own.

These calls go straight to Telegram, past the outbox:

- a payload that is not a plain object: a raw call without arguments (`api.raw.getMe()`) or a
  payload built by a class (the methods of grammY build object literals);
- a payload without `chat_id`. That covers the service calls of the bot (`getMe`,
  `setMyCommands`, `getUpdates`, `setWebhook`, ...): none of them has a `chat_id` of its own, so no
  list of them is kept. The menu of a chat names the chat inside `scope`, which the transformer
  does not read;
- a `chat_id` that is not a number, a chat named by its username (`@channel`);
- the methods of `OutboxTransformer.GROUP_METHODS_PAST_THE_OUTBOX` for a group chat: Telegram
  does not count them towards the limit of the group.

A handler that awaits a call to a chat waits for the pull of its message, the limits of the chat
and of the bot, and the send.

## Commands

The texts of `/start`, `/help` and step 7 are those of the customer journey
([`cjm.md`](../product/cjm.md), steps 1-6). Each handler builds its text with `ctx.t()`
([`i18n.md`](./i18n.md)) and sends it with one `ctx.reply()` through the outbox (see "The outbox
transformer"); the conversion sends a document or an album of them instead of a text. The next
message is routed by what it is, not by what the bot said before: the one thing they keep in the
session is the album `NotAFileMiddleware` answered last (below).

- `/start` (`StartCommand`) replies with `start-command-welcome`, the list of formats substituted.
  A repeated `/start` gives the same text.
- `/help` (`HelpCommand`) replies with `help-command-text`: the formats, the size limit of a file
  (`BOT_MAX_DOWNLOAD_SIZE`, the limit of `getFile`) and `{contact}` (`BOT_AUTHOR_CONTACT`). Both
  are variables with a default (`.env.dist`), so they change without an edit of the `.ftl`.
- `UnknownCommandMiddleware` answers a message whose text opens with a command no command of step 6
  took with the text of `/help`: it and `HelpCommand` build the text with `HelpText`
  (`command/help/help-text.ts`). A command elsewhere in the text is not one, as for grammY's
  `command()`, and such a text goes on as a text.
- `NotAFileMiddleware` answers a message with content a person sends (`CONTENT_FIELDS`: a text, a
  photo, a GIF, a sticker and the like) with `not-a-file-middleware-hint`, a request to send the
  font as a file. A GIF gets the request even though Telegram puts it into `document` as well, so
  the middleware stands above `FileIntakeMiddleware`. A document goes on to it. A service message
  (a pin, access granted from a mini app) has no content and gets no answer. An album comes as one
  message per item, each an update of its own, and only its first item gets the request: the
  middleware keeps the `media_group_id` it answered in `session.hintedMediaGroupId` and leaves an
  item of the same album unanswered. The inbox hands out the updates of a session one at a time, in
  their order ([`inbox.md`](./inbox.md)), so the first item is answered before the next is read.
- `FileIntakeMiddleware` (`middleware/file-intake/`) takes a document and checks it in the order
  of [`cjm.md`](../product/cjm.md), step 2, from the cheapest. A refusal is one reply with the text
  of its row of step 5 and no buttons; a document without a name is answered as `cjm.md` says under
  that table.
  1. The size Telegram reports in the message, `file_size`, against `BOT_MAX_DOWNLOAD_SIZE`
     (why the reported size, `cjm.md`, step 5). A document without the size passes on.
  2. The extension of `file_name`, in any case, against the formats a pair starts from
     (`SupportedFormats.toSourceList()`).
  3. The content. `TelegramFileDownloader` (`file-downloader/`) calls `getFile`, which names no chat
     and goes past the outbox, then downloads the file by plain HTTP, with the root and the token
     of the same `Api`, into `TEMP_DIR`, with a timeout of a minute. A `getFile` that refuses the
     file for its size (a document without `file_size`, or `BOT_MAX_DOWNLOAD_SIZE` above the limit
     of the server) gives `TelegramFileTooBig`, and the person gets the text of a file over the
     limit without a number ([`cjm.md`](../product/cjm.md), step 5). A `getFile` that cannot give
     the file right now, a 5xx of the file server and a failed connection give
     `TelegramFileNotDownloaded`, which the inbox retries ([`inbox.md`](./inbox.md), "Error
     classes"); a 4xx of the file server gives `TelegramFileRefused`, which a retry would not
     change. The validator of the format the extension names (`FontValidatorResolver`,
     [`font-convertor.md`](./font-convertor.md), "Signatures") reads the file, and the file is
     removed whatever the outcome. A failed removal is logged as a `warning` and keeps neither the
     answer from the person nor the error of the check from the inbox.

     `FontRejectionClassifier` sorts the error of the validator into "not in the format" and
     "broken"; which errors give the first is its `NOT_IN_FORMAT`. Only the errors of the format of
     the extension count there: a `NotSfnt` of the font inside a WOFF, a WOFF2 or an EOT file says
     that a file in its format is broken inside. A font collection named `.ttf` or `.otf` is "not
     in the format" too ([`cjm.md`](../product/cjm.md), step 5), though the validator answers it
     with `BrokenSfnt`. A WOFF or a WOFF2 file of a collection (the flavor `ttcf`) stays "broken"
     (`cjm.md`, step 5). Any other error is thrown on, and the inbox picks the outcome of the
     update by it ([`inbox.md`](./inbox.md), "Failures").

  A font that passes gets `file-intake-middleware-question` in reply to its message with the
  buttons of `FormatButtons` (`format-buttons/`), laid out as `cjm.md`, step 2, shows: the targets
  of the pairs of the source (`SupportedFormats.toTargetList()`). The reply
  sets `allow_sending_without_reply`: a document deleted during the check would otherwise fail the
  reply with a 400, which blocks the chat in the outbox. The callback data of a button names the
  target alone, `convert:<extension>` or `convert:all`: a file id does not fit the 64 bytes
  Telegram allows, so the conversion finds the source through the message the question replies to
  (below). The download serves the check alone, so a document that passes the name costs a
  `getFile` and the download of the whole file.
- `ConversionMiddleware` (`middleware/conversion/`) takes a press whose callback data starts with
  `FormatButtons.CALLBACK_DATA_PREFIX` and passes any other update on. In this order:
  1. `answerCallbackQuery`, at once, so the client stops its spinner. It names no chat and goes past
     the outbox. Telegram takes the answer for a short while only and refuses a late one with a 400
     "query is too old": a press handed out late by the inbox, behind the conversions of the same
     chat, or handled again after a failure. That refusal is logged as an `info`, and the
     conversion goes on; any other failure of the answer is thrown on.
  2. The source: the `reply_to_message` of the question the button stands under, with its
     `document`. A question whose source was deleted has no reply, and a question older than the
     Bot API lets a bot read comes as an inaccessible message, without one. Either way, and for a
     reply that holds no document, the person gets `conversion-middleware-source-unavailable`, a
     request to send the file again ([`cjm.md`](../product/cjm.md), step 4).
  3. The targets: the source format by the extension of `file_name`, as the intake took it, and
     the target among `SupportedFormats.toTargetList()` of that source, or the whole list for
     `convert:all`. Data that names no such pair comes from no button of the bot, or from a question
     asked before the pair matrix changed: it is logged as a `warning` and gets no answer beyond
     step 1.
  4. `sendChatAction` with `upload_document`, through the outbox: the chat shows "отправляет
     файл…" while the conversion runs.
  5. `TelegramFileDownloader` downloads the source again, as at the intake (its errors the same),
     once per press, and `FontConvertor` converts it into each target in turn. The downloaded source
     is removed whatever the outcome, a failed removal logged as a `warning`. A
     `FontConvertorError`, a conversion failing on our side, is logged as an `error`, and the other
     targets still go. Any other error is thrown on to the inbox, and the results already made are
     removed: the inbox handles the update anew.
  6. Telegram limits the body of a request, `BOT_MAX_UPLOAD_SIZE`, and refuses one over it with a
     413 ([`real-bot-load-test.md`](./real-bot-load-test.md), "The upload limit"), which fails the
     call and takes every file of an album with it ([`outbox.md`](./outbox.md), "Error classes").
     A result over the limit less a margin for the multipart, `REQUEST_OVERHEAD_MARGIN_BYTES`, is
     removed, logged as a `warning` and not sent.
  7. Each result is a `PathFile` named after the source with the extension of its target
     (`MyFont.woff` → `MyFont.ttf`); the domain names the file at random. The results go in the
     order of the buttons, as many to a call as fit under the same limit: two and more with
     `sendMediaGroup` as an album of documents, a single one with `sendDocument`, in reply to the
     source and without a caption. When a call fails, the results of the calls after it are removed
     and the error goes on to the inbox. The outbox removes the files once the call is sent
     ([`outbox.md`](./outbox.md), "Sending").
  8. The failed targets, if any, are named in one reply after the results: for a single format
     `conversion-middleware-failed`, for `convert:all` `conversion-middleware-failed-formats`,
     which lists them in the order of the buttons. The targets of step 6 are named in a reply of
     their own after it, `conversion-middleware-too-large`. When every target failed, it is the
     whole answer. The replies set `allow_sending_without_reply`, as the question does, for a source
     deleted during the conversion.

  The buttons stay under the question: nothing removes or edits them, and every press converts
  anew, from a fresh download.

The list of formats in all of them and in the descriptions below comes from `SupportedFormats`
(`telegram/supported-formats.ts`): `ConvertorFactory.getSupportedExtensions()`, in upper case, in
the order of the customer journey. The hint to a message that is not a file and the refusal of an
unsupported file list `toSourceText()` instead, the formats a pair starts from
(`getSourceExtensions()`): a format that is only a target would be named in the refusal of that very
format. Which texts take it, `git grep -n toSourceText -- src`. The formats the intake takes and the
buttons offer come from `SupportedFormats` too, in the same order ([`cjm.md`](../product/cjm.md)).
The order is a rank per `Extension`, so an extension added to the enum without a rank fails the
compile. What the user is promised changes with the pair matrix
([`font-convertor.md`](./font-convertor.md), "The pair table").

`Bot.setupDescriptions()` sets the description, what an empty chat with the bot shows before
`/start`, and the short description, what its profile and a shared link show (step 0 of the
customer journey). The texts are `bot-description` with `{formats}` and `{contact}` and
`bot-short-description` with `{formats}` only, in `telegram/bot/locale/`, sent with
`setMyDescription` and `setMyShortDescription` per locale as the menu is
([`i18n.md`](./i18n.md)). Telegram takes up to 512 characters for the description and 120 for the
short one and answers a longer text with a 400, which fails the start; `bot.spec.ts` checks both
lengths in every locale.

The menu (step 7 of the customer journey) is published by `Bot.setupCommands()` in two kinds of
scope. The default scope, the menu of everyone, holds `/start` and `/help`. Each chat of
`BulkMessagesCommand.chatIds` gets a scope of a chat (`BotCommandScopeChat`) with `/bulk_messages`
as well. Telegram shows a chat the menu of its most specific scope instead of the common one, not
on top of it, so the menu of a chat repeats `/start` and `/help`. Telegram takes the scope of a
chat only from a chat that has opened this bot and answers any other with `400 Bad Request: chat
not found`: the three chats are the owner's accounts, and each bot of a development slot has its
own token. On that answer `Bot.publishChatCommands()` logs a `warning` with the chat and leaves the
chat with the common menu. Any other failure of the call fails the start. The menu only hides a
command: the handler of `/bulk_messages` is registered for every chat and checks the chat itself.

`/bulk_messages` ([overview](./README.md)) pushes 10 000 `sendMessage` calls of a random text for
three hardcoded chat IDs, the chats in turn. It is shown in the menu of those chats only (above) and
runs only when sent from one of them: from any other chat `BulkMessagesCommand.handle` returns
without pushing or answering. It pushes the calls straight into `OutboxStore.pushBatch()`, past the
transformer, so that they get `OutboxPriority.Bulk`, and it waits for none of them to be sent. The
three chats yield to the chats with calls of the bot, and a reply in one of them goes before the
bulk messages pushed into it before ([`outbox.md`](./outbox.md), "Tables", the head). The
batches are of 1000: one batch is one transaction with its messages in one `jsonb` parameter. The
command has no `try/catch`: a batch that fails rejects it, the inbox picks the outcome of the update
by the error ([`inbox.md`](./inbox.md), "Failures"), and the batches pushed before it stay queued; a
retry of the update pushes them all again. The rows outlive the process: for a chat the bot cannot
reach every message fails without blocking the chat, and nothing deletes a `failed` row
([`outbox.md`](./outbox.md), "Cleanup"), so each run leaves its share of the 10 000 rows behind.
