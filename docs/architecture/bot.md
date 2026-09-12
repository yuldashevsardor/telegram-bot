# Bot

`Bot` (`telegram/bot.ts`) оборачивает `grammy.Bot<Context>` и знает только
Telegram-слой. `Context` (`bot.types.ts`) — контекст grammY с флейворами сессии,
разговоров и Fluent плюс `ctx.getUser()`; `FluentFlavor` (`locale.types.ts`) — свой,
вместо флейвора плагина ([`i18n.md`](./i18n.md)).

`Bot.setup()` собирает пайплайн строго в этом порядке, и в нём же апдейт от runner идёт
сверху вниз: каждый шаг рассчитывает на то, что заполнили предыдущие.

1. `HasSessionKeyFilter` — на входе сырой апдейт. Тем же `getSessionKey`, что и
   `session()` ниже, отбрасывает апдейты без `from` или `chat`: сессии у них нет, а всё
   ниже на неё рассчитывает. Цепочка обрывается без ошибки; ниже `ctx.from` и `ctx.chat`
   заполнены. С заданным `allowed_updates` (ниже) такие апдейты уже не запрашиваются,
   поэтому отброс здесь — редкость. Пишется он `warning`-ом сверх общей `debug` базового
   `Filter`: ниже фильтра дампа апдейта ([`user.md`](./user.md)) уже не будет, поэтому
   уровень выше. Логгер здесь ещё без `requestId` — `RequestContextMiddleware` стоит ниже
   ([`logging.md`](./logging.md)), поэтому отброшенный апдейт по `requestId` не найти.
2. `IsPrivateChatFilter` — всё ниже работает только в приватных чатах. Стоит вторым:
   `ctx.chat` у него нет и у апдейтов без ключа сессии, а своей строки в логе он не
   пишет — только общую `debug` базы, поэтому их должен раньше увидеть
   `HasSessionKeyFilter` с его `warning`. Оба фильтра выше сессии: групповому апдейту
   ключа сессии хватает, и шаг 4 завёл бы ему строку в `sessions` ещё до отброса
   ([инвариант](./invariants.md)).
3. `sequentialize()` по ключам `[chat.id, from.id]` — сериализует апдейты одного
   чата/пользователя, иначе конкурентный runner устроил бы гонку по сессии и по
   check-then-act в `FillUserToContextMiddleware` ([`user.md`](./user.md)). Стоит выше
   `session()`: тот не ленив — читает строку до `next()` и пишет после возврата, а слот
   очереди освобождается внутри этого же `next()` ([инвариант](./invariants.md)). Апдейтов
   без `chat` и `from`, на которых `sequentialize()` дал бы пустой список ключей, сюда не
   доходит: их отбросил шаг 1.
4. `session()` — ключ `${from.id}:${chat.id}`, хранилище `PgsqlStorage` (таблица
   `sessions`), payload `{ requestCount }`. Строка читается сразу (`read`), а после
   возврата из цепочки пишется обратно upsert'ом (`write`) — если сессию читали или
   меняли; новая считается изменённой с самого начала. Ошибка, брошенная ниже, до записи
   не доходит. Ниже `ctx.session` заполнен.
5. Middleware: `RequestContextMiddleware` → `TelegramCallApiMiddleware` →
   `ResponseTimeMiddleware` → `RequestLogMiddleware` → `FillUserToContextMiddleware`.
   `RequestContextMiddleware` первый: всё, что логируется ниже, пишется с `requestId`
   ([`logging.md`](./logging.md)). `ResponseTimeMiddleware` пишет `info` со временем
   вокруг `next()` без `try/catch`, поэтому у упавшего апдейта строки времени не будет.
   `RequestLogMiddleware` инкрементирует `requestCount` и дампит весь `ctx.update` на
   `debug` ([`user.md`](./user.md)); из-за инкремента сессию трогают на каждом апдейте,
   поэтому шаг 4 всегда пишет строку обратно. `FillUserToContextMiddleware` ошибок не
   ловит и ниже себя оставляет `ctx.getUser()` ([`user.md`](./user.md)).
6. Fluent ([`i18n.md`](./i18n.md)) — ниже заполнены `ctx.t` и `ctx.getFluent()`.
7. `conversations()` + `createConversation` для каждого символа
   `Tokens.Bot.Conversations`. Апдейт чата, который сейчас внутри разговора, уходит в
   точку `wait()` и до шага 8 не доходит: `createConversation` зовёт `next()`, только если
   разговор апдейт не забрал.
8. Команды из `Tokens.Bot.Command`: `command.setup(composer)`, затем
   `api.setMyCommands()` на каждую локаль ([`i18n.md`](./i18n.md)) — по сетевому вызову
   при каждом старте. Последний шаг: апдейт, не подошедший ни одной команде, дальше не
   делает ничего.

Один апдейт стоит базе: по `sessions` — `select` на входе и upsert после цепочки, если она
не упала; по `users` — 1 `select` (`existsById`) у нового пользователя, 2 (`existsById` +
`getById`) у существующего, плюс upsert ([`user.md`](./user.md)). Отброшенный на шагах 1-2
апдейт не стоит ни одного запроса.

`Bot.run()` вешает `grammy.catch(handleError)` — единственный перехватчик ошибок
пайплайна: только `critical`-лог, пользователю ничего не отвечается, и признаков сбоя он
не видит. Дальше запускается `run(grammy)` из `@grammyjs/runner` с
`runner.fetch.allowed_updates = ["message"]` (константа `ALLOWED_UPDATES` в `bot.ts`):
команды и `conversation.wait()` в приватных чатах питаются только сообщениями, а
умолчание `getUpdates` притащило бы все прочие типы, которым пайплайн отвечает отбросом.
Список перечисляет типы апдейта, а не содержимое сообщения: файл приходит тем же
`message` с `document`, и приём шрифтов список не расширяет.
Это не фильтр безопасности: список применяется на стороне Telegram, и после его смены
накопленные апдейты старых типов ещё могут прийти — фильтры остаются на месте.
`Bot.stop()` останавливает runner в пределах `BOT_GRACEFUL_SHUTDOWN_TIMEOUT`
([`application.md`](./application.md)).

`Command`, `Filter`, `Middleware` — абстрактные базы вида «`handle` + `setup(composer)`»;
`ConversationHandler` себя не вешает: наследник реализует `run`, а его `handle`
оборачивает `createConversation()` (шаг 7). `Filter.setup()` обрывает цепочку сам, вызывая
`next()` только при истинном `handle()`: `composer.filter()` grammY для этого не годится —
он не отбрасывает апдейт, а
прячет за условием лишь то, что повешено на возвращённый им composer, и обе ветки его
`branch` зовут `next()`. Пока `setup()` полагался на `filter()` и выбрасывал этот
composer, ни один фильтр репозитория не отсекал ничего (тест
`test/telegram/filter/filter.spec.ts`).

Отброс логирует сам `Filter`: строка `debug` с `constructor.name` фильтра и `update_id`.
Поэтому `Logger` инжектится в базу, а не в наследников: решение об отбросе принимается в
базе, и след о нём остаётся там же — иначе каждый новый фильтр отбрасывал бы молча, пока
автор не заведёт себе логгер. Наследник с зависимостями передаёт логгер в `super()`, без
зависимостей — не объявляет конструктор вовсе. Своя строка у фильтра остаётся, когда
нужен другой уровень или детали: `HasSessionKeyFilter` пишет `warning` с тем, какого
поля не хватило.

## TelegramCallApiMiddleware

`telegram/middleware/mutation/telegram-call-api.middleware.ts` подменяет `ctx.api.raw` на
`Proxy`. Вызов с payload-объектом, содержащим `chat_id`, превращается в задачу `TaskQueue`
(ключ — `chat_id`, приоритет `MEDIUM`, `priorityOnError: HIGH`); что при этом происходит
с Promise вызывающей стороны — в [`outbound-queue.md`](./outbound-queue.md). Мимо очереди
идут: payload создан не литералом (методы grammY такого не строят, и отправка файла тоже
идёт через очередь), нет `chat_id`, `chat_id` не число, и методы из
`TELEGRAM_NO_GROUP_RATE_LIMIT_SET` — только для групповых чатов.

grammY создаёт новый `Api` на каждый апдейт, поэтому обёртка не накапливается и не
касается `bot.grammy.api`: код, вызывающий его напрямую (`BulkMessagesCommand`), кладёт
задачу в очередь сам.

## Команды

`/start` — вход в разговор: `StartCommand.handle` зовёт `startConversation.enter(ctx)` →
`ctx.conversation.enter("start")`. Дальше `StartConversation.run()` собирает приветствие
`ctx.t("start-conversation-welcome", { formats })` ([`i18n.md`](./i18n.md)), отвечает им
задачей через очередь ([`outbound-queue.md`](./outbound-queue.md)) и встаёт на
`conversation.wait()`. На `wait()` выполнение приостанавливается; возобновит его следующий
апдейт этого чата — вторым полным проходом пайплайна, включая upsert `users`. Текст этого
апдейта уходит обратно эхом, а нетекстовый получает `start-conversation-not-text` —
просьбу прислать текст; на этом разговор завершается. Состояние разговора плагин держит в
той же сессии ([инвариант](./invariants.md)), поэтому порядок шага 3 защищает и его.
Ошибок внутри `run()` никто не ловит.

`/font_generator` — отладочная конвертация фикстуры в четыре формата
([`font-convertor.md`](./font-convertor.md)): до четырёх запусков `fontforge` на команду,
файлы остаются на диске. Конвертации идут одна за другой, и ответ уходит после каждой;
первая ошибка обрывает остаток и пользователю не видна.

`/bulk_messages` ([обзор](./README.md#обзор)) — 300 000 задач на три захардкоженных chat
ID, видна в списке команд у всех. Задачу в `TaskQueue` она кладёт сама: зовёт
`bot.grammy.api.sendMessage` напрямую, мимо подмены `ctx.api.raw`. Перед каждой
постановкой дёргается `FileHelper.createDirectoriesByDate()` по пути машины автора,
поэтому на любой другой машине до `push()` дело не доходит вовсе: `InvalidPath`,
`Promise.all` реджектится, и `info` о постановке не пишется. `try/catch` в команде нет,
reject уходит в `Bot.handleError`.
