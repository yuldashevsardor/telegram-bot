# Сквозные потоки

Что происходит в рантайме, по шагам. Структура кода и инварианты — в
[`docs/architecture.md`](./architecture.md); здесь ссылки на его разделы вида §N.

Поведение grammY описано по исходникам версии из `package-lock.json`; там, где оно
неочевидно, это сказано явно.

## 1. Старт процесса

**Триггер:** `node build/app.js` или `npm run dev`.

1. `app.ts` импортирует `reflect-metadata` (до любого класса с декораторами inversify).
2. `application.setup()`:
   - `ApplicationContext.create()` — состав «всегда нужного» (§4), по шагам:
     - `ConfigEnvStorage` — `dotenv.config()` один раз, явно.
     - `ConfigContainer` — разбор и валидация всей конфигурации. Ошибка здесь —
       `InvalidConfigError` до появления логгера, поэтому `fail()` печатает её своим
       фолбэком через `console.error` (§9).
     - `RequestContext` — обёртка над `AsyncLocalStorage`, пока без открытой области;
       область открывает middleware на каждый апдейт (поток 3).
     - `createLogger()` — `PinoLogger` (production) или `ConsoleLogger`; обоим отдаётся
       контекст запроса, из которого они читают значения при записи (§9).
   - `container.setup()` — конфиг, логгер и контекст запроса берутся геттерами контекста и
     связываются константами, дальше только биндинги, классы ещё не инстанцируются.
   - `Database.check()` — первый резолв `Database` и `select 1`: недоступная база валит
     старт здесь, а не на первом апдейте.
   - `container.get(Bot)` — конструктор бросает `InvalidConfigError`, если `BOT_TOKEN` пуст.
   - `Bot.setup()` — регистрация пайплайна (§5); внутри `setupFlavor()` читает `.ftl`
     с диска, `setupCommands()` делает сетевой `setMyCommands` — по вызову на локаль.
3. `application.run()`: `runner.run()` (синхронный; ставит `setTimeout(handleTasks, 0)`)
   → `bot.run()` (`grammy.catch(handleError)`, затем `run(grammy, ...)` — long polling
   в фоне с `allowed_updates: ["message"]`, §5).

**Ошибки:** любой сбой старта — код выхода 1 через `bootstrap().catch(fail)`. Сам `run()`
ошибку не логирует, только останавливает `runner` и пробрасывает: запись одна и делает её
`fail()`. `unhandledRejection` и `uncaughtException` тоже ведут в `fail`: он пишет `critical`
через `Logger`, а до создания контекста — своим фолбэком (§9).
Повторов нет ни для базы, ни для `setMyCommands`: временный сетевой сбой в этот момент
фатален.

## 2. Остановка процесса

**Триггер:** первый `SIGINT`/`SIGTERM` (`process.once`; второй сигнал ничего не делает).

1. `gracefulStop()` → `application.stop()` → `process.exit(0)`; ошибка в цепочке →
   `fail`, код 1.
2. `Application.stop()` (до конца `setup()` — ничего не делает) ждёт `shutdown()` не
   дольше `GRACEFUL_SHUTDOWN_TIMEOUT`; по истечении пишет `warning` и возвращается,
   брошенный шаг продолжает выполняться. `withTimeout()` гасит отказ опоздавшего шага,
   иначе он всплыл бы `unhandledRejection` уже после остановки.
3. `shutdown()`, если приложение запущено:
   - `Bot.stop()` — `runner.stop()` в пределах `BOT_GRACEFUL_SHUTDOWN_TIMEOUT`, не
     уложился — `warning`. Новые апдейты не забираются, уже взятые доигрывают.
   - `waitQueueToEmpty()` — опрашивает `taskQueue.isEmpty()` каждые
     `TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL` до `TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT`,
     логирует остаток; по сроку — `warning` с числом невыполненных задач. `isEmpty()`
     не учитывает уже выполняющийся `callback`.
   - `runner.stop()` — сбрасывает флаг; цикл выйдет на следующей итерации.
4. `container.close()` → `Database.close()` → `sql.end({ timeout: 5 })`.

**Итог:** задачи, не успевшие уйти, теряются вместе с процессом.

## 3. Входящий апдейт

**Триггер:** runner получил апдейт и вызвал `handleUpdate`. grammY создаёт **новый `Api`
на каждый апдейт**, поэтому `ctx.api` никогда не совпадает с `bot.grammy.api` (важно
для потока 4).

Пайплайн в порядке регистрации:

1. **`HasSessionKeyFilter`** — `getSessionKey(ctx) === undefined` (нет `from` или `chat`:
   пост в канале, inline-запрос): `warning` с `update_id` и тем, какого поля не хватило,
   и цепочка обрывается без ошибки и без единого запроса в базу. Ниже `ctx.from` и
   `ctx.chat` заполнены.
2. **`IsPrivateChatFilter`** — не приватный чат: цепочка обрывается без ошибки и без
   своей строки в логе. Отброс на шагах 1 и 2 пишет базовый `Filter`: `debug` с именем
   класса фильтра и `update_id`; `requestId` в записи ещё нет — область запроса
   открывает шаг 5.
3. **`sequentialize`** по `[chat.id, from.id]` — апдейты с общим ключом идут по одному.
   Почему фильтры и `sequentialize` стоят выше сессии — §5 и §14.
4. **Session.** `getSessionKey` → `${from.id}:${chat.id}`. Сессия читается сразу
   (`PgsqlStorage.read`), а после цепочки пишется обратно, если её читали или меняли
   (`write`, upsert); новая сессия считается изменённой с самого начала. Ниже
   `ctx.session` заполнен.
5. **`RequestContextMiddleware`** — выполняет остаток пайплайна в
   `requestContext.run(next)`; `requestId` кладёт в стор сам `RequestContext`. Первый из
   middleware: всё, что логируется внутри цепочки, пишется с `requestId` (§9).
6. **`TelegramCallApiMiddleware`** — подменяет `ctx.api.raw` на `Proxy` (поток 4).
7. **`ResponseTimeMiddleware`** — `await next()`, затем `info` с временем; без try/catch.
8. **`RequestLogMiddleware`** — `ctx.session.requestCount++`, затем `debug` со всем
   `ctx.update`.
9. **`FillUserToContextMiddleware`** — `existsById` → `edit` (`getById` + `save`) или
   `create` (`save`) → `ctx.getUser()`. Ошибок не ловит. `if (!ctx.from)` — ассерт инварианта
   шага 1, бросает `UpdateWithoutFrom`.
10. **Fluent** — `ctx.t()`; локаль — язык из `ctx.from.language_code`, незнакомый уводится
    в дефолтную `ru`.
11. **Conversations** — чат «внутри» conversation получает апдейт в точку `wait()`
    вместо диспетчеризации команд.
12. **Команды** — `composer.command(name, handler)`.

**База на апдейт:** до 1 `select` + 1 upsert по `sessions`; до 2 `select` + 1 upsert по
`users`.

**Ошибки:** единственный перехватчик — `Bot.handleError`, только `critical`-лог.
Пользователь ответа не получает и признаков сбоя не видит.

## 4. Исходящий вызов Telegram API

**Триггер:** любой `ctx.api.*` (в том числе `ctx.reply`) во время обработки апдейта.

1. grammY собирает payload и зовёт `ctx.api.raw[method](payload, signal)`; `Proxy`
   возвращает `callApi`.
2. `callApi` идёт **напрямую**, минуя очередь, если payload или чат под неё не подходят
   (список условий — §5). Иначе создаёт Promise, сохраняет его `resolve`/`reject`,
   строит `callback` и делает
   `taskQueue.push({ key: chatId, priorityOnError: HIGH, callback }, MEDIUM)`.
   Вызывающая сторона получает этот Promise.
3. Задача ждёт своей очереди: партиция ключа, индекс приоритета, `pull()` очередного
   цикла `Runner` (§6).
4. `handleTask`: `await task.callback()`; завершения цикл не ждёт, следующая итерация
   через `setTimeout(0)`.
5. `callback`: `messageResolve(await callRawApi(...))`; в `catch` — `messageReject(error)`
   и `throw`.

**Ошибка вызова:** `Runner` пишет `error`, при 429 ставит паузу всей очереди и возвращает
задачу с `priorityOnError`, пока не исчерпан `RUNNER_MAX_RETRIES` (§6). Вызывающая сторона
получила reject на первой ошибке; успешный повтор уже отклонённый Promise не меняет.
Обработчики команд `ctx.reply` не оборачивают, поэтому reject доходит до
`Bot.handleError`.

**Что идёт мимо очереди:** `bot.grammy.api.*` (используется `BulkMessagesCommand`, тот
кладёт задачу вручную) и multipart-загрузки — их сейчас в коде нет.

## 5. `/start`

1. `StartCommand.handle` → `startConversation.enter(ctx)` → `ctx.conversation.enter("start")`;
   состояние conversation хранится в той же сессии.
2. `StartConversation.run()`: `ctx.t("start-conversation-welcome", { formats })` →
   `ctx.reply(text)` (поток 4) → `conversation.wait()` — выполнение приостанавливается,
   следующий апдейт этого чата возобновит его здесь → `nextMessage.reply()` с текстом
   пришедшего сообщения или ключом `start-conversation-not-text`, если текста нет, →
   conversation завершается.

Два апдейта, для каждого — полный пайплайн потока 3, включая upsert `users`. Ошибок
внутри `run()` не ловится.

## 6. `/font_generator`

Тестовая команда (§1); пользовательский ввод не читается.

1. `FontGeneratorCommand.handle` → `generateRandomFonts(ctx)` один раз.
2. Для каждого из `EOT`, `OTF`, `TTF`, `WOFF2` из фиксированного
   `test/fixtures/fonts/test-font.woff`: `FontConvertor.convert()` (§7) →
   `ctx.reply(<путь к файлу>)` — текстом, сам файл не отправляется.
3. Всё в `try/catch`; пойманная ошибка пишется `error`-ом через `Logger` (§9).

До четырёх запусков `fontforge` на команду, файлы результата остаются на диске.

## 7. `/bulk_messages`

Тестовая команда (§1); видна в списке команд и доступна любому пользователю приватного
чата.

1. `handle`: 100 000 × 3 захардкоженных chat ID → `sendRandomText(chatId)`,
   `Promise.all`, `info`-запись о том, что задачи поставлены в очередь.
2. `sendRandomText`: случайная строка из 1000 символов →
   `FileHelper.createDirectoriesByDate()` по захардкоженному пути машины автора (на
   другой машине — `InvalidPath`, и `Promise.all` реджектится почти сразу) →
   `taskQueue.push({ key: chatId, callback: bot.grammy.api.sendMessage(...),
   priorityOnError: MEDIUM }, LOW)`.
3. `try/catch` нет; reject уходит в `Bot.handleError`. Задачи, успевшие попасть в
   очередь до reject, всё равно выполнятся.

## 8. Загрузка локалей Fluent

Часть `Bot.setup()`, один раз за процесс; устройство i18n — §10.

1. `createFluent(__dirname)` — все `.ftl` рядом с запущенным кодом, бандл на локаль.
2. `createFluentMiddleware(fluent)` встаёт в пайплайн: кладёт в контекст `ctx.getFluent()`
   и `ctx.t` на локали `resolveLocale(from.language_code)`.
3. Готовый `Fluent` возвращается наверх: на нём же `setupCommands()` переводит описания
   команд перед сетевым `setMyCommands` (§5).

Ошибки этого шага — неизвестная локаль в имени файла (`UnknownLocale`), локаль без единого
файла (`MissingLocaleBundle`), разбор `.ftl` — не перехватываются: валят `Bot.setup()` и
процесс (поток 1).

## 9. Логирование запроса

Не поток, а сквозной аспект. Бэкенд выбирается при старте по `NODE_ENV` (§9).

Логгер один на процесс и под запрос не подменяется. `RequestContextMiddleware`
открывает область апдейта через `RequestContext.run()`, а адаптеры в момент записи берут
`RequestContext.getValues()` — сейчас там один `requestId`. Механизм общий для обоих
адаптеров, поэтому корреляция есть и в разработке; форма записи у каждого своя (§9).

Вне области `run()` данных запроса нет, и это заметно на ошибках: `bot.catch` →
`Bot.handleError` вызывается из `handleUpdate` уже после того, как промис пайплайна
отклонён и область свёрнута, поэтому `critical` про упавший апдейт уходит без
`requestId`.
