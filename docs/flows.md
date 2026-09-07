# Сквозные потоки

Что происходит в рантайме, по шагам. Структура кода и инварианты — в
[`docs/architecture.md`](./architecture.md); здесь ссылки на его разделы вида §N.

Поведение grammY описано по исходникам версии из `package-lock.json`; там, где оно
неочевидно, это сказано явно.

## 1. Старт процесса

**Триггер:** `node build/app.js` или `npm run dev`.

1. `app.ts` импортирует `reflect-metadata` (до любого класса с декораторами inversify).
2. `application.setup()`:
   - `ConfigEnvStorage` — `dotenv.config()` один раз, явно.
   - `ConfigContainer` — разбор и валидация всей конфигурации. Ошибка здесь —
     `InvalidConfigError` до появления логгера, её печатает `fail()` через `console.error`.
   - `createLogger()` — `PinoLogger` в `Proxy` (production) или `ConsoleLogger`.
   - `container.setup()` — только биндинги, классы ещё не инстанцируются.
   - `Database.check()` — первый резолв `Database` и `select 1`: недоступная база валит
     старт здесь, а не на первом апдейте.
   - `container.get(Bot)` — конструктор бросает `InvalidConfigError`, если `BOT_TOKEN` пуст.
   - `Bot.setup()` — регистрация пайплайна (§5); внутри `setupFlavor()` читает `.ftl`
     с диска, `setupCommands()` делает сетевой `setMyCommands` — по вызову на локаль.
3. `application.run()`: `runner.run()` (синхронный; ставит `setTimeout(handleTasks, 0)`)
   → `bot.run()` (`grammy.catch(handleError)`, затем `run(grammy)` — long polling в фоне).

**Ошибки:** любой сбой старта — код выхода 1 через `bootstrap().catch(fail)`. Ошибка из
`run()` сначала пишется `critical`. `unhandledRejection` и `uncaughtException` тоже ведут
в `fail`. Повторов нет ни для базы, ни для `setMyCommands`: временный сетевой сбой в этот
момент фатален.

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

1. **Session.** `getSessionKey` → `${from.id}:${chat.id}` или `undefined`, если нет
   `from` или `chat` (пост в канале).
   - Ключ есть: сессия грузится лениво при первом `ctx.session` (`PgsqlStorage.read`),
     после цепочки пишется обратно, если менялась (`write`, upsert).
   - Ключа нет: grammY вызывает `next()`, но первое обращение к `ctx.session` бросает
     синхронно.
2. **`sequentialize`** по `[chat.id, from.id]` — апдейты с общим ключом идут по одному.
3. **`TelegramCallApiMiddleware`** — подменяет `ctx.api.raw` на `Proxy` (поток 4).
4. **`AsyncLocalStorageMiddleware`** — при `PinoLogger` создаёт `child({ requestId })`
   и выполняет остаток в `asyncLocalStorage.run()`; при `ConsoleLogger` просто `next()`.
5. **`ResponseTimeMiddleware`** — `await next()`, затем `info` с временем; без try/catch.
6. **`RequestLogMiddleware`** — `ctx.session.requestCount++`, затем `debug` со всем
   `ctx.update`. Для апдейта без ключа сессии падает здесь; ошибка всплывает через все
   middleware (session-middleware её не глотает), grammY заворачивает в `BotError` и
   отдаёт `Bot.handleError` → `critical`. Обработка апдейта на этом заканчивается.
7. **`FillUserToContextMiddleware`** — `existsById` → `edit` (`getById` + `save`) или
   `create` (`save`) → `ctx.user`. Ошибок не ловит. Своя защита `if (!ctx.from)`
   недостижима из-за шага 6.
8. **Fluent** — `ctx.t()`; локаль — язык из `ctx.from.language_code`, незнакомый уводится
   в дефолтную `ru`.
9. **`IsPrivateChatFilter`** — не приватный чат: цепочка обрывается без ошибки.
10. **Conversations** — чат «внутри» conversation получает апдейт в точку `wait()`
    вместо диспетчеризации команд.
11. **Команды** — `composer.command(name, handler)`.

**База на апдейт:** до 1 `select` + 1 upsert по `sessions`; до 2 `select` + 1 upsert по
`users`.

**Ошибки:** единственный перехватчик — `Bot.handleError`, только `critical`-лог.
Пользователь ответа не получает и признаков сбоя не видит.

## 4. Исходящий вызов Telegram API

**Триггер:** любой `ctx.api.*` (в том числе `ctx.reply`) во время обработки апдейта.

1. grammY собирает payload и зовёт `ctx.api.raw[method](payload, signal)`; `Proxy`
   возвращает `callApi`.
2. `callApi` идёт **напрямую**, минуя очередь, если payload не простой объект
   (multipart), нет `chat_id`, `chat_id` не число, или чат групповой и метод в
   `TELEGRAM_NO_GROUP_RATE_LIMIT_SET`. Иначе создаёт Promise, сохраняет его
   `resolve`/`reject`, строит `callback` и делает
   `taskQueue.push({ key: chatId, priorityOnError: HIGH, callback }, MEDIUM)`.
   Вызывающая сторона получает этот Promise.
3. `TaskQueue.push` кладёт задачу в партицию ключа (заводит её с лимитом от
   `TelegramLimitResolver`) и в индекс `keysByPriority.MEDIUM`.
4. Цикл `Runner.handleTasks` (§6) на каждой итерации делает `pull()`: уборка пустых
   остывших партиций → `null` при бане, пустой очереди или занятом общем лимите → обход
   `HIGH → MEDIUM → LOW`, первый ключ со свободным лимитом → `take()` резервирует лимит
   ключа и общий.
5. `handleTask`: `await task.callback()`; завершения цикл не ждёт, следующая итерация
   через `setTimeout(0)`.
6. `callback`: `messageResolve(await callRawApi(...))`; в `catch` — `messageReject(error)`
   и `throw`.

**Ошибка вызова:** `Runner.handleError` пишет `error`; при `error_code === 429` —
`taskQueue.ban(retry_after * 1000)` (нечитаемый `retry_after` → 1 с). `retryTask`
возвращает задачу с `priorityOnError` и `retryCount + 1`; при `retryCount >
RUNNER_MAX_RETRIES` задача отбрасывается с `error`. Вызывающая сторона получила reject на
первой ошибке; успешный повтор уже отклонённый Promise не меняет. Обработчики команд
`ctx.reply` не оборачивают, поэтому reject доходит до `Bot.handleError`.

**Что идёт мимо очереди:** `bot.grammy.api.*` (используется `BulkMessagesCommand`, тот
кладёт задачу вручную) и multipart-загрузки — их сейчас в коде нет.

## 5. `/start`

1. `StartCommand.handle` → `startConversation.enter(ctx)` → `ctx.conversation.enter("start")`;
   состояние conversation хранится в той же сессии.
2. `StartConversation.run()`: `ctx.t("welcome", { formats })` → `ctx.reply(text)` (поток 4)
   → `conversation.wait()` — выполнение приостанавливается, следующий апдейт этого чата
   возобновит его здесь → `nextMessage.reply(nextMessage.message?.text || "Чет не
   получилось...")` → conversation завершается.

Два апдейта, для каждого — полный пайплайн потока 3, включая upsert `users`. Ошибок
внутри `run()` не ловится.

## 6. `/font_generator`

1. `FontGeneratorCommand.handle` → `generateRandomFonts(ctx)` один раз.
2. Для каждого из `EOT`, `OTF`, `TTF`, `WOFF2` из фиксированного
   `tempDir/app/test-fonts/test-font.woff`: `FontConvertor.convert()` (§7) →
   `ctx.reply(<путь к файлу>)` — текстом, сам файл не отправляется.
3. Всё в `try/catch` с `console.log(error)`, мимо `Logger`.

Пользовательский ввод не читается. Запуск `fontforge` до четырёх раз, файлы остаются на
диске.

## 7. `/bulk_messages`

Видна в списке команд и доступна любому пользователю приватного чата (issue
[#3](https://github.com/yuldashevsardor/telegram-bot/issues/3)).

1. `handle`: 100 000 × 3 захардкоженных chat ID → `sendRandomText(chatId)`,
   `Promise.all`, `console.log("done")`.
2. `sendRandomText`: случайная строка из 1000 символов →
   `FileHelper.createDirectoriesByDate("/home/sardor/applications/telegram-bot/tmp")`
   (захардкоженный путь; на другой машине бросает `InvalidPath`, и `Promise.all`
   реджектится почти сразу) → `taskQueue.push({ key: chatId, callback:
   bot.grammy.api.sendMessage(...), priorityOnError: MEDIUM }, LOW)`.
3. `try/catch` нет; reject уходит в `Bot.handleError`. Задачи, успевшие попасть в
   очередь до reject, всё равно выполнятся.

## 8. Загрузка локалей Fluent

Часть `Bot.setup()`, один раз за процесс.

1. `FileHelper.findFilesByExtensions(<rootDir>/src/infrastructure/bot, [".ftl"])`.
2. Локаль — предпоследний сегмент имени файла (`start.conversation.locale.ru.ftl` →
   `ru`); не из `LOCALES` — `UnknownLocale`.
3. `fluent.addTranslation()` на локаль, `isDefault` — только у `ru`. Локаль без файлов —
   `MissingLocaleBundle`.
4. `useFluent({ defaultLocale: "ru", localeNegotiator: resolveLocale(from.language_code) })`.
5. Готовый `Fluent` возвращается наверх: на нём же `setupCommands()` переводит описания
   команд (§5 architecture.md).

Ошибка разбора `.ftl`, как и ошибки шагов 2-3, не перехватывается: валит `Bot.setup()`
и процесс (поток 1).

## 9. Логирование запроса

Не поток, а сквозной аспект. Бэкенд выбирается при старте по `NODE_ENV` (§9).

- `PinoLogger`: `Proxy` из `Application.createLogger()` на каждый доступ к свойству
  проверяет `asyncLocalStorage.getStore()?.get("logger")` и подставляет дочерний логгер с
  `requestId`, созданный в `AsyncLocalStorageMiddleware`. Порог дочерний берёт у родителя.
- `ConsoleLogger`: middleware пропускает настройку, все строки от параллельных апдейтов
  неразличимы.
