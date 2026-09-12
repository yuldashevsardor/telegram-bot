# DI и жизненный цикл

## DI

`Container extends InversifyContainer` (`container/container.ts`), `setup()`
идемпотентен. Конфиг, логгер и `RequestContext` он берёт готовыми у `ApplicationContext`
(ниже) и связывает первыми константами, затем `setupModules()` (внутри — `setupBot()`),
`setupServices()`, `setupInfrastructure()`. Всё singleton.

Символы — `Symbol.for(...)` в одном словаре `common/tokens.ts` (`Tokens`), сам список
веток там же. Ветка называет владельца, ключ — роль внутри него, поэтому имя класса в
ключе повторяется только там, где роли у класса нет (`Tokens.Bot.Bot`). Ветка
`Infrastructure` — исключение из правила «владелец»: в ней лежит готовое из
`ApplicationContext` плюс `Database`, то есть то, у чьего токена владельца-модуля нет.
Словарь лежит в `common/`, а не в `container/`: иначе за именем собственной зависимости
домен ходил бы в инфраструктуру.

Реестр ручной ([инвариант](./invariants.md)), и молчит он по-разному: забытый биндинг
сервиса ничем себя не выдаёт, пока символ никто не внедряет, — первый же `@inject` валит
резолв «No matching bindings found»; команды и разговоры резолвятся по своим реестрам
(шаги 7-8 [`bot.md`](./bot.md)), поэтому символ без биндинга валит `Bot.setup()`, то есть
старт, а не первый апдейт; middleware и фильтры заданы списками в `bot.ts` — забытый в
списке не попадёт в пайплайн и не скажет об этом ничего. Ветки словаря от совпадения имён
не спасают: глобален не путь в объекте, а строка внутри `Symbol.for` (почему — сказано в
шапке самого словаря). Отсюда `RequestContext` (контекст запроса) и
`Tokens.Bot.Middleware.RequestContext` (его middleware): пути разные, а строка у второго
длиннее — короткую уже занял контекст запроса.

Конфигурация раздаётся узкими срезами, а не целиком: `setup()` берёт `ConfigContainer` у
`ApplicationContext` (ниже) и связывает его куски константами под своими токенами —
`Tokens.TaskQueue.CommonLimit` (`config.limits.common`), `Tokens.Font.Convertor.Settings`
(`{ tempDir }`) и остальные из ветки владельца. Потребитель берёт срез обычным `@inject`,
тип среза лежит рядом с ним самим (`FontConvertorSettings` в
`font-convertor.types.ts`, `RunnerSettings` в `runner.types.ts`), поэтому домен о
`ConfigContainer` не знает и в тесте строится обычным `new` с литералом настроек
(`test/domain/task-queue/task-queue.spec.ts`). Состав среза сверяет компилятор на месте
биндинга: несуществующее поле конфигурации не соберётся, тогда как прежний
`@ConfigValue("ключ.строкой")` валил первое обращение к свойству — то есть, возможно,
сильно позже старта.

`Container.close()` закрывает пул Postgres и сбрасывает `alreadySetup`, но биндинги не
снимает: контейнер одноразовый на процесс. Повторный `setup()` пройдёт молча — дубли
свалят первый же резолв ошибкой «Ambiguous match», включая резолв `Database` внутри
самого `close()`.

## Application

`ApplicationContext` (`infrastructure/application/application-context.ts`) — состав того,
что нужно приложению всегда: конфиг, логгер, контекст запроса. Эти объекты существуют до
контейнера, потому что собрать его без них нельзя. Контекст собирает себя сам
(`ApplicationContext.create()`): внутри `ConfigEnvStorage` → `ConfigContainer` →
`RequestContext` → выбор адаптера логгера.

Класс статический целиком: части лежат на нём и выдаются `getConfigContainer()`,
`getLogger()`, `getRequestContext()`, экземпляра нет вовсе. Так контекст нельзя потерять —
ссылку на объект восстановить было бы нечем, а собранный логгер и хранилище остались бы в
процессе без единого входа к ним. Обращение до `create()` —
`ApplicationContextIsNotCreated`.

Контекст один на процесс: у второго было бы своё хранилище запроса, и логгер читал бы не
тот стор, который открыл middleware ([`logging.md`](./logging.md)), то есть корреляция
сломалась бы молча. Поэтому повторный `create()` не ошибка, а выход без пересборки. Поля
заполняются только после сборки всех частей: упавший на конфиге `create()` оставляет
контекст пустым, и следующий начинает с нуля.

Дальше контекст никуда не расходится: `Application.setup()` берёт из него `cc` и `logger`,
`container.setup()` — три константы для биндингов. Потребители получают части из
контейнера по отдельности: `Tokens.Infrastructure.Logger` и `Tokens.Infrastructure.RequestContext` —
через `@inject`; `ConfigContainer` связан под своим токеном, но не внедряется никуда —
классы получают срезы конфигурации (выше). Контекст не инжектится никуда, иначе он стал бы вторым
DI. Состав держится коротким по
той же причине: `Database` в него не входит, у неё свой жизненный цикл на
`container.close()` (выше).

`Application` (`infrastructure/application/application.ts`) — жизненный цикл; создаётся
`new` в `app.ts`, в контейнере не значится.

### Старт

**Триггер:** `node build/app.js` или `npm run dev`.

1. `app.ts` импортирует `reflect-metadata` — до любого класса с декораторами inversify.
2. `application.setup()`:
   - `ApplicationContext.create()` — `dotenv.config()` в `ConfigEnvStorage` один раз и
     явно, дальше разбор и валидация всей конфигурации ([`config.md`](./config.md)).
     Конфиг внутри контекста собирается до логгера (из него берётся и адаптер, и порог),
     поэтому `InvalidConfigError` доходит до `fail()`, когда логгера ещё нет: тот пишет
     через `ApplicationContext.getLogger()`, а на `ApplicationContextIsNotCreated`
     откатывается на `console.error` ([`logging.md`](./logging.md)). Область запроса на
     старте не открыта — её открывает middleware на каждый апдейт
     ([`logging.md`](./logging.md)).
   - `container.setup()` — только биндинги, классы ещё не инстанцируются (выше).
   - `Database.check()` — первый резолв `Database`, то есть здесь же отрабатывает её
     конструктор ([`storage.md`](./storage.md)); `select 1` валит старт тут, а не на
     первом апдейте.
   - `container.get()` для `TaskQueue`, `Runner` и `Bot`: пустой `BOT_TOKEN` валит
     конструктор `Bot` уже после проверки базы ([`config.md`](./config.md)).
   - `Bot.setup()` — сборка пайплайна ([`bot.md`](./bot.md)); по дороге читаются `.ftl` с
     диска ([`i18n.md`](./i18n.md)) и уходит сетевой `setMyCommands` на каждую локаль.
3. `application.run()`: `runner.run()` — синхронный, ставит цикл очереди на `setTimeout`
   и сразу возвращает управление ([`task-queue.md`](./task-queue.md)), затем `bot.run()` —
   long polling в фоне ([`bot.md`](./bot.md)).

**Ошибки:** любой сбой старта уходит в `fail()` — `critical` и выход с кодом 1
(`bootstrap().catch(fail)`). Логирует только `fail()`: два `critical` на один отказ
удваивали бы счётчик алертов, поэтому `run()` при отказе молча останавливает уже
запущенный `runner` и пробрасывает ошибку дальше. Туда же ведут
`unhandledRejection` и `uncaughtException`. Повторов нет ни для базы, ни для
`setMyCommands`: временный сетевой сбой в этот момент фатален.

### Остановка

**Триггер:** первый `SIGINT`/`SIGTERM` (`process.once`). Второй сигнал вторую остановку
не запускает, но и не безобиден: слушателя уже нет, Node применяет действие по умолчанию
и убивает процесс (130/143 вместо `exit(0)`) посреди начатой остановки.

1. `gracefulStop()` → `application.stop()` → `process.exit(0)`; ошибка в цепочке —
   `fail()` и код 1.
2. `Application.stop()` (до конца `setup()` — ничего не делает) ждёт `shutdown()` не
   дольше `GRACEFUL_SHUTDOWN_TIMEOUT`; по истечении пишет `warning` и возвращается, а
   брошенный шаг продолжает выполняться, пока его не оборвёт `process.exit(0)` шага 1.
   `withTimeout()` гасит отказ опоздавшего шага,
   иначе он всплыл бы `unhandledRejection` уже после остановки.
3. `shutdown()`, если приложение запущено:
   - `Bot.stop()` — если runner ещё работает, `runner.stop()` в пределах
     `BOT_GRACEFUL_SHUTDOWN_TIMEOUT`, не уложился — `warning`. Источник апдейтов
     закрывается, новых `getUpdates` нет; а вот завершения уже отданных в пайплайн
     апдейтов `stop()` не ждёт — они доигрывают параллельно остальным шагам, и всё, что
     не успело, обрывает `process.exit(0)`.
   - `waitQueueToEmpty()` — опрашивает `taskQueue.isEmpty()` каждые
     `TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL` до `TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT`,
     логирует остаток; по сроку — `warning` с числом невыполненных задач. `isEmpty()`
     считает только лежащее в очереди: задачу, которую `Runner` уже взял, счётчик не
     видит.
   - `runner.stop()` — только флаг, цикл выйдет на следующей итерации
     ([`task-queue.md`](./task-queue.md)): `Runner.run()` и `Runner.stop()` синхронные
     ([инвариант](./invariants.md)).
4. `container.close()` → `Database.close()` → `sql.end({ timeout: 5 })`
   ([`storage.md`](./storage.md)).

Общий срок обязан быть больше суммы двух частных (`ConfigContainer` проверяет) и меньше
`stop_grace_period: 20s` контейнера — это уже не проверяется
([инвариант](./invariants.md)). Собственные сроки зависимостей (`sql.end({ timeout: 5 })`)
в проверку не входят.

Задачи, не успевшие уйти, теряются вместе с процессом.
