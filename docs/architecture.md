# Архитектура

Этот документ описывает систему **в том виде, в каком она существует в коде прямо сейчас**, включая шероховатости, мёртвый код и незавершённые фичи. Это не описание идеализированного целевого дизайна. Там, где что-то неоднозначно или не подтверждается одним лишь кодом, это помечено прямо в тексте и заведено в трекере, а не додумано.

Сверяться с `README.md` не с чем (там сейчас только заголовок), поэтому всё изложенное выведено из исходников, истории git и конфигурационных файлов по состоянию на коммит `ca8b1c2`.

**Примечание о ревизии:** документ прошёл второй, более глубокий проход верификации, сфокусированный на рантайм-поведении (точная семантика Promise, точные внутренности grammY на зафиксированной версии `1.10.1`, точный порядок выполнения middleware и режимы отказов). Этот проход целиком, поток за потоком, описан в [`docs/flows.md`](./flows.md) — читайте его ради точной трассировки «триггер → последовательность → ветвления → изменения состояния → обработка ошибок» для каждого значимого потока. Настоящий документ обновлён по месту везде, где тот проход показал, что исходное (структурное) описание было неполным или неверным; такие исправления помечены ниже пометкой **(исправлено)**.

**Правила репозитория (действуют для всей документации и всех изменений):**

- **Документация и issues ведутся на русском языке.** Этот документ, `docs/flows.md`, `CLAUDE.md` и любые новые документы пишутся по-русски. Issues — заголовок, описание и комментарии — тоже создаются на русском. Идентификаторы кода — имена файлов, путей, классов, методов, переменных окружения, команд — остаются в оригинальном виде: переводится текст, а не код.
- **Любые изменения вносятся только через отдельную ветку и Pull Request.** Прямые коммиты и пуши в `main`/`master` не делаются никогда — ни для кода, ни для документации, ни для мелких правок. Ветка создаётся от актуального `main` (`feat/…`, `fix/…`, `chore/…`, `docs/…`), одна ветка/PR — одна логически цельная задача.

## 1. Обзор

**Основное назначение системы — конвертация шрифтов**: перенос файлов шрифтов между максимально возможным числом форматов (`src/domain/font-convertor/`, §7). Telegram — это фронтенд доставки для этой возможности, а не смысл проекта; `User`, `BulkMessagesCommand` и миграции Postgres существуют потому, что они нужны Telegram-фронтенду, а не как самостоятельные фичи. Читайте остальную часть документа с учётом этого приоритета: домен конвертации шрифтов — та часть, в которую стоит вкладываться; обвязка из бота/DI/логирования/конфига вокруг него — инфраструктура, обслуживающая приём и выдачу шрифтов через Telegram.

Построено на **grammY**, связано через DI-контейнер **inversify**, хранилище — **PostgreSQL**. `/start` — входная conversation; `/font_generator` задействует домен конвертации шрифтов (в текущей сборке неработоспособен — см. §7); `/bulk_messages` — ручной инструмент нагрузочного тестирования пайплайна ограничения скорости Telegram, а не пользовательская фича (см. issue [#3](https://github.com/yuldashevsardor/telegram-bot/issues/3)).

Стек:
- **grammY** (`grammy`) — фреймворк Telegram Bot API, запускается через `@grammyjs/runner` (long-polling, конкурентная обработка апдейтов) с `@grammyjs/conversations` для многошаговых сценариев.
- **inversify** — DI-контейнер, связывается вручную (без автообнаружения по декораторам).
- **PostgreSQL** — через клиент `postgres` (porsager) в рантайме и `node-pg-migrate` (тянет за собой `pg`) для миграций схемы.
- **pino** / обычный `console` — два бэкенда логирования за доменным интерфейсом `Logger`.
- **FontForge** (внешний CLI, вызывается через shell) — конвертация форматов шрифтов.
- **Fluent** (`@moebius/fluent` + `@grammyjs/fluent`) — i18n, на практике сегодня только русский.

Код организован в свободном стиле гексагональной/чистой архитектуры: `domain/` содержит бизнес-логику и порты (интерфейсы), `infrastructure/` — адаптеры (Postgres, grammY, логгеры, конфиг), `common/` — сквозные типы и ошибки. Это разделение довольно последовательно применено для `user` и `logger` и куда менее последовательно в остальных местах (например, `broker`/`planner`/`slot-manager` — чистая доменная логика без отдельного порта, поскольку абстрагировать там нечего: внешней системы нет).

## 2. Точка входа и bootstrap

`src/app.ts` — единственная точка входа:

```
import "reflect-metadata"        // нужен inversify для метаданных декораторов
await container.setup()          // связывает все DI-биндинги (см. §4)
bot = container.get<Bot>(...)
await bot.run()
process.once("SIGINT", () => void gracefulStop())
process.once("SIGTERM", () => void gracefulStop())
process.on("unhandledRejection", fail)
process.on("uncaughtException", fail)
bootstrap().catch(fail)
```

`stop()` вызывает `bot.stop()` (что это влечёт — см. §5), затем `container.close()`. `gracefulStop()` оборачивает `stop()`: успех — `process.exit(0)`, ошибка — `fail`. `fail(error)` печатает ошибку в `console.error` и завершает процесс с кодом 1.

Сбой старта фатален: `Bot.run()` пробрасывает ошибку дальше после логирования, `bootstrap().catch(fail)` завершает процесс с кодом 1, поэтому супервизор (Docker `restart: on-failure`, systemd, Kubernetes) видит ненулевой код.

Заметные пробелы:
- Ошибки старта и падения из `unhandledRejection`/`uncaughtException` уходят в `console.error`, а не в структурированный `Logger`: на момент сбоя логгер может быть ещё не собран.
- `Container.close()` (`src/infrastructure/container/container.ts`) — заглушка: он лишь сбрасывает внутренний флаг `alreadySetup`, если тот выставлен, и больше ничего не делает. Пул соединений с Postgres (`Database.sql`) при остановке явно не закрывается.

## 3. Карта директорий

```
src/
  app.ts                    точка входа
  common/                   сквозные типы и базовый класс ошибки
  domain/                   бизнес-логика + порты (не зависят от фреймворков)
    broker/                 воркер отправки исходящих сообщений (§6)
    planner/                приоритетная очередь + шлюз ограничения скорости (§6)
    slot-manager/           примитив одиночного слота с задержкой (§6)
    font-convertor/         конвертация форматов шрифтов (§7)
    user/                   сущность/интерфейс репозитория/сервис пользователя (§8)
    logger/                 интерфейс Logger + enum Level (§9)
  helper/                   общие утилиты (string/number/file/sleep)
  infrastructure/           адаптеры (конкретные реализации)
    bot/                    обвязка grammY: команды, conversations, middleware, фильтры, сессия (§5)
    config/                 загрузка env (§12)
    container/              связывание DI через inversify (§4)
    database/               подключение к Postgres + миграции (§11)
    logger/                 реализации Console/Pino логгеров (§9)
    repository/             реализации репозиториев на Postgres (§11)
    async-local-storage.ts  общий экземпляр AsyncLocalStorage (§9)
docker/pgsql/                init-скрипт docker-entrypoint для локального Postgres
Makefile                     единственная точка входа для частых команд (§15)
Dockerfile                   образ приложения: Node + FontForge + зависимости (§15)
docker-compose.db.yml        pgsql, один экземпляр на машину (§15)
docker-compose.app.yml       app, свой в каждом рабочем дереве (§15)
scripts/                     обслуживание деревьев: worktree-init.sh, bot-token.sh, claude-worktree-guard.sh (§15)
test/                        (почти пустой) набор тестов (§14)
```

Все внутренние импорты используют алиас путей `app/*` (маппится на `./src/*` в `tsconfig.json`, разрешается на этапе сборки через `tsc-alias`), относительные пути не применяются никогда — правило ESLint `no-restricted-imports` полностью запрещает относительные импорты, так что `app/...` — единственный разрешённый способ ссылаться на другие модули. В файлах миграций это правило локально отключено, поскольку `node-pg-migrate` требует обычных импортов.

## 4. Внедрение зависимостей (DI)

`src/infrastructure/container/container.ts` определяет `Container extends InversifyContainer` с идемпотентным `setup()`:

```
setup()
 └─ setupModules()        Planner, Broker (singleton) → setupBot()
     └─ setupBot()        Bot, фильтры, middleware, команды, хранилище сессий, conversations
 └─ setupServices()       стек font-convertor, стек user (всё singleton)
 └─ setupInfrastructure() Config, Database (singleton) → setupInfrastructureLogger()
```

Биндинги используют символы на базе `Symbol.for(...)`, сгруппированные в пространства имён `Infrastructure` / `Modules` / `Services` (`src/infrastructure/container/symbols/`), — это вручную поддерживаемый реестр, а не автообнаружение по декораторам. **Добавление новой команды, middleware или сервиса требует ручной регистрации в `container.ts`** — ничего не упадёт с ошибкой, если вы про это забудете.

Единственная неочевидная часть связывания — `setupInfrastructureLogger()`:
1. Биндит `ConsoleLogger` и `PinoLogger` как конкретные синглтоны, оба сконфигурированы через `config.logger.levels`.
2. **Перебиндивает** символ `PinoLogger` на `Proxy`: каждый доступ к свойству сначала проверяет `asyncLocalStorage.getStore()?.get("logger")` и использует его, если тот есть, иначе откатывается на синглтон. Именно так дочерние логгеры на запрос (помеченные `requestId`, см. §9) прозрачно подменяются, причём код-потребитель об этом ничего не знает.
3. Разрешает `config.logger.default` (env `LOGGER_DEFAULT`, `ConsoleLogger` или `PinoLogger`) и биндит *полученный* экземпляр как единый обобщённый `Infrastructure.Logger` — это единственный символ, который реально внедряется через `@inject<Logger>(Infrastructure.Logger)` во всей остальной кодовой базе.

Помимо внедрения через конструктор, два ленивых декоратора свойств тянут значения напрямую из модульного синглтона `container` при первом обращении к свойству, минуя конструктор (паттерн service locator):
- `@ConfigValue<T>(key, defaultValue?)` (`src/infrastructure/config/config-value.decorator.ts`) — поиск по «точечному» пути в `Config` (например, `"bot.token"`), бросает исключение, если значение не найдено и дефолта нет. Используется в `Bot`, `Database`, `Broker`, `Planner`, `FontGeneratorCommand` и др.
- `@PgSql()` (`src/infrastructure/database/pgsql.decorator.ts`) — тем же способом достаёт `Database.sql`. Используется в `PgSqlUserRepository`, `PgsqlStorage`.

## 5. Слой бота

`src/infrastructure/bot/bot.ts` — `Bot` оборачивает grammY-объект `TelegramBot<Context>`. Тип `Context` (`bot.types.ts`) складывается из `GrammyContext & SessionFlavor<SessionPayload> & ConversationFlavor & FluentContextFlavor & { user: User }`.

`Bot.run()`: `broker.run()` (запускает воркер исходящей очереди, §6) → `setup()` → `grammy.catch(handleError)` → `run(this.grammy)` из `@grammyjs/runner` (long-polling runner, обрабатывающий апдейты конкурентно, а **не** встроенный `bot.start()` из grammY).

`setup()` собирает пайплайн ровно в таком порядке — порядок важен, и это самое близкое к диаграмме архитектуры обработки запроса, что есть в репозитории:

1. **`setupSession()`** — middleware `session()` из grammY. Ключ сессии — `` `${ctx.from.id}:${ctx.chat.id}` `` (на пару пользователь+чат). Бэкенд хранилища — `PgsqlStorage` (на Postgres, §11). Полезная нагрузка (`SessionPayload`) сейчас — просто `{ requestCount: number }`.
2. **`setupSequential()`** — `sequentialize()` из `@grammyjs/runner`, ключ `[chat.id, from.id]`. Необходим, потому что runner обрабатывает апдейты конкурентно; это сериализует апдейты, затрагивающие один и тот же чат/пользователя, чтобы избежать гонок по состоянию сессии.
3. **`setupMiddlewares()`** — `Composer`, выстраивающий цепочку в порядке: `TelegramCallApiMiddleware` → `AsyncLocalStorageMiddleware` → `ResponseTimeMiddleware` → `RequestLogMiddleware` → `FillUserToContextMiddleware`.
4. **`setupFlavor()`** — i18n на Fluent (см. §10).
5. **`setupFilters()`** — `IsPrivateChatFilter` ограничивает всё, зарегистрированное после этой точки, приватными чатами (`ctx.chat?.type === "private"`).
6. **`setupConversations()`** — `grammy.use(conversations())`, затем регистрация каждого связанного символа `Modules.Bot.Conversations` (сейчас это только `StartConversation`) через `createConversation(...)`.
7. **`setupCommands()`** — разрешает каждый связанный символ `Modules.Bot.Command` (`StartCommand`, `BulkMessagesCommand`, `FontGeneratorCommand`), вызывает у каждого `command.setup(composer)` (регистрирует `bot.command(name, handler)`), затем вызывает `grammy.api.setMyCommands(commands)` — **живой сетевой вызов к Telegram при каждом старте процесса** — и лишь после этого монтирует composer.

`Command`/`Filter`/`Middleware`/`ConversationHandler` — тонкие абстрактные базовые классы одинаковой формы «шаблонный метод»: абстрактный `handle`/`run` плюс `setup(composer)`, встраивающий экземпляр в grammY.

`Bot.stop()`: останавливает runner, затем вызывает `waitPlannerToEmpty()` — неограниченный цикл `while(true)`, опрашивающий `planner.isEmpty()` каждые 3 секунды **без таймаута**, — и лишь потом останавливает broker. Если исходящая очередь так и не опустеет (например, при активном бане по рейт-лимиту Telegram), остановка может зависнуть навсегда.

### `TelegramCallApiMiddleware`

Самый необычный middleware (`src/infrastructure/bot/middleware/mutation/telegram-call-api.middleware.ts`): он подменяет `ctx.api.raw` JS-объектом `Proxy`. Каждый исходящий вызов Telegram API, несущий `chat_id`, — кроме небольшого белого списка безопасных для групп методов (`TELEGRAM_NO_GROUP_RATE_LIMIT_SET`, например `getChat`, `sendChatAction`), применяемого **только к групповым чатам** (для приватных чатов исключений нет никогда, даже для этих же read-only методов), — перехватывается, оборачивается в вручную разрешаемый `Promise` и кладётся в очередь `Planner` вместо немедленной отправки. Это и есть вход в пайплайн ограничения скорости, описанный в §6.

**(исправлено)** Оборачивается только `ctx.api` — и, согласно исходникам самого grammY (проверено на зафиксированной версии `1.10.1`), **на каждый входящий апдейт создаётся новый экземпляр `Api`** (`ctx.api` никогда не является тем же объектом, что `bot.grammy.api`, и два разных апдейта не делят один объект). То есть обёртка не накапливается между апдейтами, но это же означает, что она никак не влияет на код, который вызывает Telegram напрямую через `bot.grammy.api`, а не через `ctx.api`: ровно так делают `BulkMessagesCommand` и мёртвый код в `StartCommand`, и как следствие им приходится вручную дублировать вызов `planner.push(...)` (полная трассировка — `docs/flows.md`, Поток 4). Полезная нагрузка, не являющаяся простым объектом (например, multipart-загрузка файла), тоже полностью минует очередь, поскольку перехват распознаёт только payload типа простого `Object` с полем `chat_id`. Сегодня ни один живой путь этого не задействует, но это реальная дыра в покрытии. Ещё в этом файле есть неиспользуемая мёртвая константа `WEBHOOK_REPLY_METHOD_ALLOW_SET` — объявлена и нигде не используется.

### Хранилище сессий

`src/infrastructure/bot/session/pgsql.storage.ts` — `PgsqlStorage implements StorageAdapter<SessionPayload>`, работает поверх Postgres через `@PgSql()`. Читает и пишет таблицу `sessions` напрямую (без абстракции репозитория, в отличие от `users` — см. §11).

## 6. Пайплайн ограничения скорости исходящих (Broker / Planner / SlotManager)

Самая архитектурно своеобразная часть кодовой базы. Несмотря на название, `Broker` — это **не** обобщённый pub-sub брокер сообщений: вся подсистема существует ради троттлинга *исходящих* вызовов Telegram API, чтобы бота не ограничил и не забанил Telegram.

**Поток:**

```
вызов ctx.api.* с chat_id
   │  (Proxy из TelegramCallApiMiddleware на ctx.api.raw)
   ▼
Planner.push(message, priority)     3 FIFO-корзины: HIGH / MEDIUM / LOW
   │
   ▼  (цикл опроса Broker'а на setTimeout вызывает Planner.pull())
Planner.pull()
   │  1. null, если глобальный бан или все очереди пусты
   │  2. null, если общий («common») SlotManager не свободен
   │  3. проход HIGH → MEDIUM → LOW; внутри корзины — с начала к концу,
   │     ищется первое сообщение, у которого свободен SlotManager его чата
   │  4. резервирует и общий слот, и слот чата, возвращает сообщение
   ▼
Broker выполняет message.callback() (исходный, не проксированный вызов API)
   │
   ├─ успех → резолвит исходный Promise вызывающей стороны
   └─ ошибка → planner.push(message, priorityOnError) для повторной постановки;
                при HTTP 429 — planner.ban(retry_after) (глобальный бан)
```

- **`Planner`** (`src/domain/planner/planner.ts`) держит три приоритетные корзины и, на каждый чат, лениво создаваемый `SlotManager` по ключу `chatId` (`limits.group` или `limits.private` в зависимости от `message.isGroup`), плюс один общий `commonManager` (`limits.common`). Поскольку он ищет первое *подходящее* сообщение, а не строго голову очереди, порядок доставки не является строгим FIFO — сообщение зажатого рейт-лимитом чата может быть пропущено в пользу более позднего сообщения в другой чат. **`Planner.managers` — это `Map`, из которой никогда ничего не удаляется**: каждый уникальный chat ID, с которым бот когда-либо общался, оставляет экземпляр `SlotManager` в памяти на всё время жизни процесса (неограниченный рост для долгоживущего бота с большим числом пользователей).
- **`SlotManager`** (`src/domain/slot-manager/slot-manager.ts`) — минимальный шлюз с одним слотом и остыванием, а не token bucket: `reserveDuration = interval / number` (равномерный интервал), `isFree()` проверяет, истекло ли остывание, `reserve()` бросает исключение при вызове, когда слот не свободен. Создаётся обычным `new SlotManager(limit)`, вне DI.
- **`Broker`** (`src/domain/broker/broker.ts`) сам себя планирует через `setTimeout` (это не настоящий consumer/subscriber): забирает сообщение из `Planner`, спит `settings.sleepInterval`, если ничего нет, иначе выполняет. `Broker.run()`/`.stop()` объявлены синхронными (возвращают `void`), но вызываются с `await` в `Bot` — безвредно, но вводит в заблуждение. Интервал опроса при простое (`BROKER_SLEEP_INTERVAL`) в коде по умолчанию 1000 мс, но в закоммиченном `.env.dist` переопределён на **10 мс**.

Настроенные лимиты (`.env.dist`, намеренно повторяют официальные рекомендации Telegram по рейт-лимитам Bot API):

| Область | Количество | Интервал  |
|---------|------------|-----------|
| common  | 30         | 1000 мс   |
| private | 3          | 1000 мс   |
| group   | 20         | 60000 мс  |

`broker.errors.ts` и `planner.errors.ts` существуют, но пусты — все соседние доменные модули определяют свои подклассы `RuntimeError`, а эти два нет, что намекает на незавершённую обработку ошибок здесь.

**(исправлено — существенно) Логика повтора при ошибке и бана по 429 с высокой вероятностью является мёртвым кодом в рантайме.** Если проследить точную цепочку Promise (подробности — `docs/flows.md`, Поток 4): замыкание `callback`, собираемое в `TelegramCallApiMiddleware`, вызывает настоящий, не проксированный `originRaw[method](payload, signal)` **без await** — оно просто передаёт получившийся (ещё висящий) Promise в `messageResolve(...)`. Поскольку резолв Promise'а другим Promise'ом перенимает *итоговое* состояние внутреннего Promise'а, исходный вызывающий код (например, тот, кто ждал `ctx.reply(...)`) корректно увидит отказ, если реальный вызов Telegram упадёт, — но сам `callback()`, не имея в теле ни одного `await`, резолвится немедленно, независимо от того, чем позже закончится настоящий вызов. Поэтому `try { await message.callback(); } catch (error) { ...повтор, бан по 429... }` в `Broker.handleMessage` практически никогда не видит ошибку: его блок `catch` сработал бы только на *синхронный* throw при вызове `originRaw[method]`, а обычные сбои Telegram API (включая 429) такого не дают — это асинхронные reject'ы. **Итог: упавшее сообщение не ставится в очередь повторно, а `Planner.ban()` по HTTP 429 на практике не достигается** — код внешне реализует backoff/retry, но механизм, связывающий его с реальными ошибками, сломан. Структурное чтение кода этого не показывает; потребовалось проследить точную семантику `async`/`Promise.resolve(thenable)`. Структурно также не ловится и другое: рекурсивная ветка `Broker.handleMessages()` (когда сообщение *есть*) не дожидается завершения реального сетевого вызова, прежде чем сразу забрать следующее, — по той же причине. Так получается приемлемая пропускная способность, но это побочный эффект той же ошибки, а не намеренный дизайн.

## 7. Конвертация шрифтов

`src/domain/font-convertor/` конвертирует файлы шрифтов между форматами (WOFF, WOFF2, OTF, TTF, EOT) для команды `/font_generator`.

```
FontConvertor.convert(params)
  → выводит расширение исходника, бросает ошибку, если исходное === целевому
  → генерирует случайное имя файла во временной директории с разбиением по дате
    (FileHelper.createDirectoriesByDate: tempDir/YYYY/M/D)
  → ConvertorFactory.get(from, to)   — таблица диспетчеризации примерно по 20
                                        конкретным классам пар (WoffToEot, EotToOtf, ...),
                                        по файлу на пару в convertor/{ext}/
  → конкретный Convertor.validate()  — белый список расширений и MIME-типов
                                        (MIME выводится из расширения пакетом
                                        `mime-types`, а не по содержимому файла)
  → FontForge.convert(src, dist)     — вызов CLI `fontforge` через shell:
      fontforge -c 'import fontforge; font = fontforge.open("{SRC}");
                     font.generate("{DIST}")'
```

Строка команды `fontforge` собирается наивным шаблонизированием через `.replace()` — **экранирования путей для shell нет**. Сейчас риск невелик, поскольку пути — сгенерированные внутри случайные строки, но это стало бы вектором инъекции команд, если бы путь когда-нибудь начал зависеть от пользователя.

`SVG` объявлен поддерживаемым расширением (`FontForge.supportedExtensions`), но **ни одной пары конвертации для него не зарегистрировано** в `ConvertorFactory` — любая конвертация SVG бросит `ConvertorNotFound`. В `convertor.ts` (строки ~58–61) есть закомментированный блок определения MIME по содержимому через `FileHelper.getMimeType()` (который вызывает `file --mime-type -b`) — это мёртвая связь с тем, что, судя по всему, должен был давать `mmmagic`; сам `mmmagic` нигде в `src/` не используется (см. §13).

Временная директория с разбиением по дате (`FileHelper.createDirectoriesByDate`, `src/helper/file-helper/file-helper.ts`) строит путь как `tempDir/<год>/<месяц 1-12>/<день месяца 1-31>`. Самый глубокий сегмент берётся из `dayjs().date()`; до issue [#30](https://github.com/yuldashevsardor/telegram-bot/issues/30) там вызывался `.day()` — день недели, — из-за чего раскладка циклилась еженедельно по семи корзинам. Каталоги `0`–`6`, оставшиеся в `TEMP_DIR` от старой схемы, не удаляются: разбирать их предстоит задаче об очистке временных файлов (issue [#37](https://github.com/yuldashevsardor/telegram-bot/issues/37)).

**(исправлено)** Сгенерированный файл шрифта **никогда фактически не отправляется пользователю.** `FontConvertor.convert(...)` возвращает локальный серверный путь в файловой системе, и оба места, которые её вызывают (`FontGeneratorCommand.generateRandomFonts` и идентичный мёртвый код в `StartCommand.generateRandomFonts`), делают `await ctx.reply(eotPath)` — отвечают **строкой пути как текстом**, а не загружают файл. Вдобавок ошибка в `FontGeneratorCommand.handle()` (`promises.push(this.generateRandomFonts.bind(this, ctx))` кладёт ссылку на привязанную функцию, а не вызывает её) означает, что `/font_generator` сейчас **вообще не делает ничего наблюдаемого** при вызове — ни ответа, ни конвертации, ни ошибки, просто тишина. Полная трассировка — `docs/flows.md`, Поток 6.

## 8. Домен User

`src/domain/user/` следует небольшому «DDD-lite» паттерну: сущность + DTO + интерфейс репозитория (порт) + сервис приложения, реализованный поверх Postgres в инфраструктурном слое.

- **`User`** (`user.ts`) — сущность с настоящими приватными полями JS `#fields` (id, firstname, lastname, username, isBot, lastActiveTime, createdTime, updatedTime). Каждый сеттер вызывает приватный `toggleUpdatedTime()`, автоматически проставляя `updatedTime`, — инвариант, обеспечиваемый на уровне сущности.
- **`UserRepository`** (`user.repository.ts`) — чистый интерфейс: `getById`, `existsById`, `save` (upsert), `delete`.
- **`UserService`** (`user.service.ts`) — `create(dto)` и `edit(id, dto)` (частичное обновление, применяются только определённые поля), оборачивает сбои в `UserCreateError`/`UserEditError`. `create()` сам по себе не защищает от дублей — он полагается на то, что вызывающая сторона уже проверила `existsById`, *и* на то, что `save()` в репозитории работает как upsert, размазывая один инвариант по двум слоям.
- **`PgSqlUserRepository`** (`src/infrastructure/repository/pgsql.user.repository.ts`) реализует порт: `insert ... on conflict (id) do update set ...` через клиент `postgres` с tagged-template-запросами. Приватные мапперы `rowToEntity`/`entityToRow` переводят между доменной формой и snake_case-строкой БД.

Всё это приводится в движение **`FillUserToContextMiddleware`** на каждом входящем апдейте: он проверяет `existsById`, затем `create` или `edit`, проставляя `lastActiveTime = dayjs()` (это и есть механизм отслеживания «последней активности»). Если `ctx.from` отсутствует (например, посты в канале), он логирует ошибку и выходит **не вызывая `next()`**.

**(исправлено)** Эта защита на практике — **недостижимый мёртвый код**. Она выполняется *после* `RequestLogMiddleware` в пайплайне (§5), а первая же инструкция `RequestLogMiddleware`, `context.session.requestCount++`, синхронно бросает исключение ровно для того же класса апдейтов: любой апдейт без `ctx.from` заодно проваливает разрешение ключа сессии в grammY (`getSessionKey` требует `ctx.from`), а обращение к `ctx.session`, когда ключ не разрешился, бросает исключение (проверено по исходникам grammY `1.10.1`). Так что пайплайн падает на `RequestLogMiddleware`, на один middleware раньше, чем сработала бы явная проверка внутри `FillUserToContextMiddleware`, — и так для каждого реального случая, ради которого эта проверка писалась. Настоящий «механизм отбрасывания» таких апдейтов — это необработанное исключение, всплывающее как лог уровня `critical` через `Bot.handleError`, а не явная проверка. Полная трассировка — `docs/flows.md`, Поток 3.

Также отмечено дополнительно: **`RequestLogMiddleware`** (`src/infrastructure/bot/middleware/request-log.middleware.ts`) инкрементирует `context.session.requestCount` и логирует **весь сырой объект `ctx.update`** (включая текст сообщения и данные отправителя) на уровне `debug` для каждого дошедшего до него апдейта. Это единственное место во всей кодовой базе, где `SessionPayload.requestCount` читается или пишется (считается, но нигде не используется), а про логирование полного payload'а стоит знать, если debug-логи когда-нибудь начнут уезжать куда-то менее доверенное, чем локальный диск.

`UserAlreadyExists` (`user.errors.ts`) определён, но нигде не бросается — мёртвый, поскольку `save()` делает upsert, а не падает на конфликте.

## 9. Логирование

Чистое разделение порт/адаптер:
- **`src/domain/logger/logger.ts`** — интерфейс `Logger` (`critical/error/warning/info/debug(message, payload?)`), порт, от которого зависит доменный код. `logger.types.ts` определяет enum `Level` (`CRITICAL/ERROR/WARNING/INFO/DEBUG`).
- **`src/infrastructure/logger/`** — адаптеры: `AbstractLogger` (общая фильтрация по уровням через `setLevels`), `ConsoleLogger` (формат `[timestamp] [LEVEL] message payload`, сериализует payload-ошибки через `serialize-error`), `PinoLogger` (обёртка над `pino` с кастомными числовыми уровнями, совпадающими с доменным enum `Level`, `useOnlyCustomLevels: true`, есть метод `child(context)`).

Какой конкретный адаптер реально внедряется как `Infrastructure.Logger`, решается один раз в `Container.setupInfrastructureLogger()` (§4) на основе `config.logger.default` (env `LOGGER_DEFAULT`; по умолчанию `PinoLogger` в production и `ConsoleLogger` в остальных случаях).

**Корреляция запросов:** `src/infrastructure/async-local-storage.ts` экспортирует один общий `AsyncLocalStorage<Map<string, any>>`. `AsyncLocalStorageMiddleware` (первый в цепочке middleware после middleware с прокси API) выполняет на каждый апдейт `asyncLocalStorage.run(new Map([["logger", childLogger]]), next)`, где `childLogger` — это `PinoLogger.child()`, помеченный `requestId` (uuid v4). Поскольку DI-биндинг `PinoLogger` — это `Proxy`, читающий `asyncLocalStorage.getStore()?.get("logger")` при каждом доступе к свойству (§4), любой код, внедряющий `Infrastructure.Logger`, автоматически получает этот скоупленный на запрос коррелированный логгер — *но только когда активен `PinoLogger`*. Сам middleware защищён условием `if (!(logger instanceof PinoLogger)) return next();`, поэтому **в разработке (где по умолчанию `ConsoleLogger`) этот middleware фактически ничего не делает и корреляции запросов нет**.

Об одном совпадении имён стоит знать: `src/infrastructure/config/config.ts` локально объявляет собственный `type Logger = { default: symbol; levels: Level[] }` — то же имя, что у доменного интерфейса `Logger`, но совершенно другая суть (это *конфигурация выбора* логгера, а не контракт логгера). Тип ограничен файлом, так что вреда нет, но grep путает.

## 10. i18n (Fluent)

`Bot.setupFlavor()` (`bot.ts`) рекурсивно собирает все файлы `.ftl` внутри `src/infrastructure/bot` (`FileHelper.findFilesByExtensions`), выводит локаль каждого файла из его имени по соглашению — `*.locale.<lang>.ftl` (например, `start.conversation.locale.ru.ftl` → `ru`), а не из структуры директорий, группирует файлы по локали и регистрирует каждую группу в экземпляре `Fluent()` из `@moebius/fluent`. Подключается к grammY через `useFluent()` из `@grammyjs/fluent`.

Во всём репозитории существует **один-единственный** файл `.ftl` (русский, один ключ: `welcome`). **`localeNegotiator` захардкожен и всегда возвращает `"ru"`** — так что, несмотря на файловую обвязку, способную обслуживать несколько локалей, сегодня бот реально может отдавать только русский, независимо от языка Telegram-клиента пользователя. В `StartConversation.run()` строкой ниже вызова `ctx.t("welcome", ...)` есть ещё и захардкоженная русская запасная строка («Чет не получилось...»), полностью минующая Fluent на этом пути, — непоследовательное использование системы i18n даже внутри её единственного потребителя.

Это действительно новая и незавершённая часть: самый свежий коммит `ca8b1c2` («Implement support i18n (Flover)») добавил зависимости Fluent, единственный файл `.ftl`, логику `setupFlavor()` и реорганизовал файлы команд/conversation'ов в подкаталоги по командам, чтобы файлы локалей лежали рядом со своим обработчиком.

## 11. Хранение данных

**Клиент в рантайме:** `Database` (`src/infrastructure/database/database.ts`) оборачивает npm-пакет **`postgres`** (porsager, SQL через tagged-template, без ORM) и конструируется с настройками из `@ConfigValue`. Пул соединений открывается в момент конструирования; `debug: !isProduction` означает, что вне production логирование запросов включено по умолчанию.

**Миграции:** **отдельная** библиотека, `node-pg-migrate` (которая сама зависит от `pg`), запускается через `npm run migrate` → читает `migrate.json`. Это значит, что в зависимостях репозитория две клиентские библиотеки Postgres: `postgres` — для запросов приложения в рантайме, `pg` — транзитивно и только для инструментов миграций (подтверждено: ничто в `src/` не импортирует `"pg"` напрямую). Выглядит намеренно (инструменты схемы против рантайма приложения), но об этом стоит знать, чтобы не принять за случайность.

Существуют три миграции (`src/infrastructure/database/migrations/`), по порядку:
1. `..._users-table.ts` — создаёт `users` (`id` int PK «User ID in telegram», `first_name`, `last_name`, `username`, `is_bot` boolean, `last_active_time`/`created_time`/`updated_time` timestamptz).
2. `..._create-sessions-table.ts` — создаёт `sessions` (`key` уникальная строка, `value` jsonb, таймстемпы) — под адаптер хранилища сессий grammY (§5).
3. `..._change-id-column-type-on-users-table.ts` — расширяет `users.id` с `integer` до `bigint` (миграция-исправление: ID пользователей Telegram могут выходить за диапазон 32-битного знакового int).

`migrations/common/utils.ts`/`common/template.ts` содержат общие сокращения для колонок и шаблон-скаффолд, используемый `node-pg-migrate` при генерации новых файлов миграций.

**Покрытие репозиториями:** репозиторий есть только у `users` (`PgSqlUserRepository`, §8); `sessions` читается и пишется напрямую из `PgsqlStorage` без слоя репозитория — непоследовательность в том, как обращаются к этим двум таблицам.

## 12. Конфигурация и окружение

`Config` (`src/infrastructure/config/config.ts`) загружает `.env` через `dotenv` + `dotenv-expand` **в момент импорта модуля** (поэтому значения в `.env` могут ссылаться на другие переменные; обратите внимание, что Compose при передаче `.env` через `env_file` подстановку `${...}` не делает — значение уходит в контейнер как есть).

Переменные окружения, которые реально потребляет `Config`:

| Переменная | Назначение |
|---|---|
| `ENVIRONMENT` | `development`/`production`, определяет `isProduction` |
| `TEMP_DIR` | базовая директория для временных файлов font-convertor |
| `FONT_FORGE_PATH` | путь к бинарнику FontForge |
| `LIMIT_COMMON_NUMBER`/`_INTERVAL`, `LIMIT_PRIVATE_NUMBER`/`_INTERVAL`, `LIMIT_GROUP_NUMBER`/`_INTERVAL` | конфигурация рейт-лимитов для `Planner`/`SlotManager` (§6) |
| `BROKER_SLEEP_INTERVAL` | интервал опроса в `Broker` |
| `BOT_TOKEN` | обязательна — конструктор `Bot` бросает исключение, если пусто |
| `LOGGER_DEFAULT`, `LOGGER_LEVELS` | какой бэкенд логирования и какие уровни активны |
| `DATABASE_HOST`, `_PORT`, `_NAME`, `_USER_NAME`, `_USER_PASSWORD`, `_CONNECTION_LIMIT`, `_CONNECTION_IDLE_TIMEOUT`, `_CONNECTION_MAX_LIFETIME` | подключение к Postgres |

Переменные, присутствующие в `.env.dist`, но **нигде в `src/` не читаемые**: `DATABASE_SUPERUSER_NAME`/`_PASSWORD` и `DATABASE_TIMEZONE`/`DATABASE_DATE_STYLE` — они нужны только `docker-compose.db.yml` и init-скрипту, не приложению.

**`DATABASE_URL`** в `.env.dist` отсутствует намеренно: её никогда не читают ни `Database`, ни `Config` (они всегда собирают подключение из отдельных полей host/port/user/pass), единственный потребитель — `node-pg-migrate`, и собирается она в `docker-compose.app.yml`, где подстановка `${...}` действительно работает.

`DATABASE_HOST`/`DATABASE_PORT` в `.env` описывают подключение к БД **снаружи** контейнеров (`DATABASE_PORT` — порт, проброшенный на хост через `ports: ${DATABASE_PORT}:5432`); внутри compose-сети приложение всегда ходит на `pgsql:5432`, что задано в блоке `environment` сервиса `app` и приоритетнее `env_file`.

**`BOT_TOKEN` в истории git.** В `.env.dist` было закоммичено похожее на настоящее значение открытым текстом — начиная с `d60f7b1` и на протяжении нескольких десятков коммитов. Сейчас переменная пуста, а само значение мертво: Bot API отвечает на него `401 Unauthorized` (проверено 03.09.2026). Из истории оно при этом никуда не делось и доступно любому по `git log -p -- .env.dist`.

Историю переписывать намеренно не стали: `git filter-repo` сломал бы все существующие клоны и ссылки на коммиты, а значение всё равно осталось бы в форках и кэшах GitHub — после того как токен перестал работать, переписывание ничего не закрывает. Считайте историческое значение мёртвым, а не секретным (issue [#36](https://github.com/yuldashevsardor/telegram-bot/issues/36)).

От повторной утечки защищает secret scanning с push protection, включённый на самом репозитории: GitHub распознаёт формат токена Bot API и отклоняет push с ним. Отдельной проверки на секреты в `pre-commit` намеренно нет — дублировать ею серверную защиту не стали.

## 13. Внешние интеграции и зависимости

- **Telegram Bot API** — через grammY + `@grammyjs/runner` (long polling; режим webhook нигде не настроен).
- **FontForge** — внешний CLI, вызывается через shell в стиле `child_process` (§7). Ожидается в `$PATH`, если не переопределён через `FONT_FORGE_PATH`.
- **PostgreSQL** — единственное внешнее хранилище данных (§11).

**Мёртвые зависимости** — объявлены в `package.json`, но нигде в `src/` не используются:
- **`mmmagic`** (+ `@types/mmmagic`) — предполагаемое назначение (определение MIME по содержимому) видно только как закомментированный мёртвый код в `font-convertor/convertor/convertor.ts`; фактический `FileHelper.getMimeType()` вместо этого вызывает системную команду `file`, да и та достижима только из того же мёртвого блока.
- **`puppeteer`** — использования не найдено нигде; никакой логики рендеринга/скриншотов в кодовой базе вообще нет.

## 14. Тестирование

- **Конфигурация прогона — `.mocharc.json`** в корне: `require` (`ts-node/register`, `tsconfig-paths/register`), маска `spec` и `color`. Скрипт `test` в `package.json` сведён к голому `mocha`. `tsconfig-paths/register` обязателен: без него `ts-node` не разрешает алиас `app/*` и mocha падает на загрузке spec-файла.
- **`test/services/message-broker/slot-manager/slot-manager.spec.ts`** — **единственный** spec-файл во всём репозитории. Он напрямую создаёт `SlotManager` (без моков) и проверяет: свежий менеджер свободен → не свободен после `reserve()` → снова свободен после истечения интервала → повторный `reserve()` бросает исключение. Ожидание таймаута — `await` по промису, а не голый колбэк `setTimeout`, поэтому Mocha действительно дожидается ассерции.
- **`npm test` зелёный: 4 passing.** До этого прогон был сломан трижды подряд, и историю стоит помнить, потому что все три поломки типовые: spec импортировал `src/domain/slot-manager/slot-manager` вместо алиаса `app/*`; в скрипте не был подключён `tsconfig-paths/register` (добавлен вместе с контейнеризацией, §15), из-за чего mocha падала на загрузке файла; проверка исключения была написана как `expect(manager.reserve.call(manager)).to.throw(...)` — вызов происходил внутри `expect`, и исключение улетало мимо ассерции, — а отложенная ассерция из `setTimeout` срабатывала уже после завершения прогона и роняла процесс необработанной `AssertionError`.
- Путь директории теста (`test/services/message-broker/...`) остался с времён до реорганизации исходников — понятия `services/message-broker` в текущем `src/` не существует (модуль — `src/domain/slot-manager/`, вызывается из `src/domain/broker/`), это наследие коммитов «Global refactor».
- **Покрытие — `nyc`, скрипт `test:coverage` (цель `make coverage`).** Конфигурация `nyc` живёт в `package.json` и расширяет `@istanbuljs/nyc-config-typescript`; долгое время этот пакет не был установлен, и конфигурация ничего не значила — теперь он в `devDependencies`. Отчёт считается по TypeScript-исходникам, а не по скомпилированному выводу: `nyc` инструментирует то, что отдаёт `ts-node`, и разворачивает покрытие обратно по source maps (`sourceMap: true` в `tsconfig.json`). Каталог `coverage` смонтирован с хоста в `docker-compose.app.yml`, иначе `lcov` оставался бы внутри одноразового контейнера и пропадал вместе с ним; `make coverage` создаёт этот каталог на хосте заранее, потому что созданный Docker'ом достался бы `root`, а процесс в контейнере работает от `node`.
- **Итог:** реального тестового покрытия практически ноль. Ни у доменных сервисов (`Broker`, `Planner`, `FontConvertor`, `UserService`), ни у инфраструктуры (`Bot`, middleware, `Config`, DI-контейнер), ни у хелперов тестов нет.

## 15. Сборка и рабочий процесс разработки

- **`Makefile` — единственная точка входа для частых команд.** Цели — тонкие обёртки над `docker compose` и npm-скриптами; и те и другие разобраны ниже, чтобы было видно, что происходит внутри целей, а не как способ работы в обход них. `make` без аргументов печатает список целей: `help` объявлена целью по умолчанию и собирает описания из комментариев `##` в самом `Makefile`, поэтому отдельного списка команд, способного разойтись с реальностью, нигде не заводится.
    - Имена проектов Compose цели не переопределяют, и это существенно: `-p` для приложения добавлять нельзя — все рабочие деревья склеятся в один проект, а разделение на два compose-файла (см. ниже) потеряет смысл.
    - Цели, поднимающие бота (`up`, `app-up`, `restart`), перед стартом сами продлевают аренду `BOT_TOKEN` (`scripts/bot-token.sh renew`). Без действующей аренды `renew` занимает свободный слот и переписывает `BOT_TOKEN` в `.env` — кроме основного дерева, где в `.env` лежит значение, которого в пуле нет даже закомментированным: там токен вписывают руками, и трогать его нельзя. В дереве задачи исключения нет, `.env` там копия основного, и незнакомый пулу токен означает унаследованный. Отказ `renew` (пула нет вовсе, свободных слотов не осталось) цели понижают до предупреждения и запуск не отменяют — бот стартует с тем `BOT_TOKEN`, что уже лежит в `.env`.
    - `restart` пересоздаёт контейнер (`docker compose up -d --force-recreate app`), а не перезапускает существующий: `docker compose restart` не перечитывает `env_file`, поэтому сменившийся в `.env` `BOT_TOKEN` до работающего бота не дошёл бы.
    - Всё исполняется в контейнерах: на хосте ни Node, ни зависимостей нет, так что перечисленные ниже npm-скрипты сами по себе на хосте не запускаются. Разовые команды (`build`, `typecheck`, `test`, `test-watch`, `coverage`, `lint`, `lint-fix`, `format-check`, `format`, `check`, `migrate`, `migrate-create`) идут через `docker compose run --rm app` — одноразовый контейнер из того же образа, работающего бота они не требуют. Цели `shell` и `psql` идут через `docker compose exec`, потому что их смысл как раз в том, чтобы попасть внутрь уже работающего контейнера — приложения и базы соответственно.
    - Поднятая база нужна и одноразовому контейнеру: сеть базы объявлена в `docker-compose.app.yml` внешней (см. ниже), а создаёт её проект базы, поэтому при полностью погашенном окружении `run --rm` падает на ненайденной сети. Требование снято только на бота, не на базу.
    - `db-reset` — единственная цель с необратимым эффектом на чужие деревья, поэтому её тело вынесено в `scripts/db-reset.sh`. База одна на машину, а в дереве задачи `tmp/pgsql` — симлинк на основное дерево, так что локально выглядящая цель стирает данные всех параллельных сессий: скрипт спрашивает подтверждение (`CONFIRM=1` пропускает вопрос, без tty без него отказ) и отказывается работать, пока в сети `telegram-bot-db_default` работают контейнеры приложения других деревьев — своё дерево он отличает по label `com.docker.compose.project.working_dir`. Сканирование повторяется после ответа на вопрос: пауза перед ним ничем не ограничена, и за это время в соседнем дереве может подняться контейнер.
    - Границы этой защиты стоит держать в голове. Она видит только запущенные контейнеры, поэтому чужое дерево с контейнером, исчерпавшим `restart: on-failure`, в неё не попадает. Контейнер удалённого дерева (`git worktree remove` контейнеры не гасит, каталога на диске уже нет) она называет, но цель им не блокирует — иначе цель осталась бы заблокированной насовсем, а погасить контейнер предложенным `make app-down` негде. Контейнер, у которого label дерева пуст, наоборот считается чужим и блокирует: единственная защита от необратимой потери данных должна ошибаться в сторону отказа. Пути с обеих сторон приводятся к физическому виду через `pwd -P`: compose пишет в label логический `$PWD`, а `git rev-parse --show-toplevel` отдаёт путь с разрешёнными симлинками, и дерево, лежащее по пути через симлинк, иначе увидело бы собственный контейнер чужим. И стирается тот каталог, который резолвится из `tmp/pgsql` вызывающего дерева, — у работающего контейнера базы bind может указывать на другой путь (он вморожен тем деревом, из которого делали `db-up`, и переживает удаление этого дерева); для цели это неважно, потому что после `down` контейнер пересоздаётся уже с путём того дерева, откуда его поднимут, но «данные базы удалены» относится к будущему старту, а не к тому кластеру, который работал минуту назад.
- `npm run build` (цель `make build`) — `del-cli -rf build && tsc && tsc-alias` (компиляция, затем переписывание алиаса `app/*` в относительные пути для скомпилированного вывода).
- `npm start` / `npm run start:prod` — `node build/app.js` (второй выставляет `NODE_ENV=production`).
- `npm run dev` — `node --watch` + `ts-node` + `tsconfig-paths` по `src/app.ts`, без сборки; этим и запускается контейнер приложения.
- `npm run migrate` (цели `make migrate` и `make migrate-create name=…`) — запускает `node-pg-migrate` с `migrate.json` (действие передаётся аргументом: `npm run migrate -- up`). Скрипт предварительно подключает `tsconfig-paths/register`: файлы миграций импортируют `src/infrastructure/database/migrations/common/utils` относительно `baseUrl`, а `ts-node` сам такие пути не разрешает.
- `npm test` (цель `make test`) — `mocha`; параметры прогона живут в `.mocharc.json`, а не в аргументах скрипта (см. §14). `npm run test:watch` (цель `make test-watch`) — то же с `--watch`, `npm run test:coverage` (цель `make coverage`) — `nyc mocha` (см. §14).
- `npm run typecheck` (цель `make typecheck`) — `tsc --noEmit`: то же, что делает первый шаг `build`, но без эмита и без очистки `build/`. Проверяются только `src`: `include` в `tsconfig.json` ограничен `src/**`, а `**/*.spec.ts` исключён явно, так что типы тестов этот скрипт не смотрит.
- **Проверки кода — npm-скрипты, цели `Makefile` только запускают их в контейнере**, поэтому набор файлов и флаги описаны в одном месте: `lint` / `lint:fix` — `eslint src test`, `format` / `format:check` — `prettier` по `src/**/*.ts` и `test/**/*.ts`. Целям можно сузить набор файлов (`make lint files="src/app.ts"`), и в этом случае они идут мимо скрипта, напрямую через `npx`: `npm run lint -- src/app.ts` дописал бы файл к аргументам скрипта, а не заменил их, и проверился бы всё равно весь код.
- `npm run check` (цель `make check`) — `typecheck`, `lint`, `format:check` и `test` подряд; одна команда, воспроизводящая то, что смотрят на ревью. CI в репозитории нет, так что других потребителей у неё пока нет.
- **Docker** — вся среда контейнеризована; на хосте достаточно одного Docker. Поднимается она целями `Makefile`: `make up` — база (если не поднята) и приложение этого дерева, `make db-up` / `make app-up` — то же по отдельности, `make app-down` / `make db-down` — погасить, плюс `make logs`, `make restart`, `make db-reset`. Разбор самих compose-файлов ниже показывает, что стоит за целями. Подробности запуска — в `README.md`. **Среда только для разработки**: production-конфигурации в репозитории нет.
    - `Dockerfile` одностадийный: `node:24.20.0-bookworm-slim` + `fontforge-nox`, `npm ci` со всеми зависимостями, исходники, `USER node` (каталог `/app` принадлежит `node`, иначе `tsc` не может создать `build/` и `typings/`). Версия Node продублирована в `ARG NODE_VERSION` и в `package.json#engines` — связи между ними нет, синхронизировать вручную.
    - Окружение разнесено на два compose-файла, потому что база одна на машину, а приложений столько, сколько рабочих деревьев. `docker-compose.db.yml` — только `pgsql` (`postgres:18-alpine` с healthcheck; данные — bind-mount `./tmp/pgsql`, смонтированный на `/var/lib/postgresql`, потому что в `postgres:18` кластер лежит в `$PGDATA=/var/lib/postgresql/18/docker`, а не в `.../data`, как было в `postgres:14`), под фиксированным именем проекта `telegram-bot-db`. `docker-compose.app.yml` — только `app` (`./src` смонтирован с хоста, `npm run dev`), без фиксированного имени проекта: Compose берёт его из имени каталога, поэтому у каждого дерева свои контейнер и образ, а `down` в дереве задачи (`make app-down`) не гасит базу.
    - Приложение находит базу по имени сервиса `pgsql` во внешней сети `telegram-bot-db_default`, то есть базу нужно поднять первой. `depends_on: service_healthy` при этом недоступен — сервисы в разных проектах, — поэтому старт до готовности базы обрабатывается через `restart: on-failure:5`: миграции падают, контейнер поднимается заново.
    - В рабочем дереве задачи `tmp/pgsql` — симлинк на основное дерево (его ставит `scripts/worktree-init.sh`, цель `make worktree-init`), поэтому `docker-compose.db.yml`, поднятый из любого дерева, попадает в тот же кластер, а не создаёт второй. `BOT_TOKEN` каждое дерево берёт из пула `tmp/bot/tokens` через `scripts/bot-token.sh` (цели `make token-acquire` / `token-renew` / `token-release` / `token-status` / `token-add`): два процесса на long polling с одним токеном получают от Telegram 409 Conflict.
    - Миграции накатываются **тем же контейнером приложения** перед стартом бота (`command: sh -c "npm run migrate -- up && exec npm run dev"`); отдельного сервиса для них нет, потому что образ и так содержит `ts-node` и исходники.
    - `docker/pgsql/docker-entrypoint-initdb.d/init-user-db.sh` при первой инициализации по-прежнему создаёт роль и базу приложения (не суперпользователя).
    - **`npm start` после `npm run build` в этом образе не заработает**: `tsc` не копирует `.ftl` в `build/`, а `Bot.setupFlavor` ищет их по `<cwd>/src/infrastructure/bot` — см. issue [#19](https://github.com/yuldashevsardor/telegram-bot/issues/19).
- **Линтинг/форматирование** — ESLint (TypeScript + Prettier + правила порядка импортов и запрет относительных импортов, отмеченный в §3) + Prettier (отступ 4 пробела, строки до 140 символов, двойные кавычки) + хук Husky `pre-commit`, запускающий `lint-staged` (`eslint --fix`, затем `prettier --write` по staged-файлам `.ts`).
- Версия Node фиксируется в двух местах — `ARG NODE_VERSION` в `Dockerfile` и `package.json#engines`; `.nvmrc` в репозитории нет, потому что Node на хосте не нужен.

- **Правило «дерево на задачу» подкреплено хуками Claude Code.** `.claude/settings.json` вешает `scripts/claude-worktree-guard.sh` на `SessionStart` (напоминание, если сессия стартовала в основном дереве) и на `PreToolUse` для `Edit|Write|NotebookEdit` (отказ править файл, лежащий в основном дереве). Дерево опознаётся сравнением `git rev-parse --show-toplevel` с каталогом от `--git-common-dir`; оба пути приводятся к физическому виду через `pwd -P`, как в `db-reset.sh`, иначе дерево по пути через симлинк не совпало бы само с собой. Границу стоит держать в голове: хук получает только `tool_input.file_path`, поэтому правки через shell (`sed`, heredoc, скрипты) в основном дереве он не видит.

## 16. Сквозные потоки

Этот раздел — только краткая сводка. **Точная последовательность «триггер → компоненты → ветвления → изменения состояния → обращения к хранилищу → внешние вызовы → обработка ошибок → побочные эффекты» по каждому значимому потоку описана в [`docs/flows.md`](./flows.md)** — там, где эти описания расходятся, приоритет у него, поскольку он получен более глубоким проходом верификации, сфокусированным на рантайм-поведении.

**Входящий апдейт:**
загрузка сессии (Postgres, ключ по пользователю+чату) → `sequentialize()` (сериализует апдейты одного чата/пользователя) → `TelegramCallApiMiddleware` (патчит `ctx.api.raw` для исходящих вызовов) → `AsyncLocalStorageMiddleware` (помечает логгер, скоупленный на запрос) → `ResponseTimeMiddleware` / `RequestLogMiddleware` (замер времени + логирование; **именно здесь пайплайн реально падает на апдейтах без `ctx.from`, а не в `FillUserToContextMiddleware` — см. §8 и `docs/flows.md`, Поток 3**) → `FillUserToContextMiddleware` (upsert строки `users`, проставление `lastActiveTime`) → подключение локали Fluent → `IsPrivateChatFilter` (отбрасывает апдейты не из приватных чатов) → диспетчеризация conversation/команд (`/start`, `/font_generator`, `/bulk_messages`).

**Исходящее сообщение (ограничение скорости):**
см. схему в §6 — перехват в `TelegramCallApiMiddleware` → приоритетная очередь `Planner`, ограничиваемая `SlotManager`'ами → цикл опроса `Broker`'а выполняет вызов → **структурно** 429 приводит к глобальному бану и повторной постановке в очередь, но, согласно исправлению в §6, этот путь в рантайме почти наверняка никогда не достигается.

**`/font_generator`:**
обработчик команды → *(баг: конвертация фактически никогда не запускается — см. §7)* → если бы путь был достижим: `FontConvertor.convert()` → диспетчеризация через `ConvertorFactory` к конкретному конвертору пары → валидация (белый список расширений + MIME) → `FontForge` вызывает CLI `fontforge` → **получившийся путь к файлу отправляется обратно текстом, а не сам файл** (§7). Явного шага очистки временных файлов на этом пути не найдено — сгенерированные файлы в `TEMP_DIR/<год>/<месяц>/<день месяца>/`, судя по всему, накапливаются, а не удаляются после использования (очистки нет и в остальном коде — issue [#37](https://github.com/yuldashevsardor/telegram-bot/issues/37)).

## 17. Известные проблемы и открытые вопросы

Здесь лежали два плоских списка — «Известные проблемы / хрупкие места» и «Открытые вопросы / неясности». Оба вынесены в трекер (issue [#23](https://github.com/yuldashevsardor/telegram-bot/issues/23)): список задач, живущий в документе, не виден в очереди работ, ему нельзя назначить приоритет и по нему не понять, что уже исправлено.

**Актуальный перечень — в [issues репозитория](https://github.com/yuldashevsardor/telegram-bot/issues).** Каждый пункт заведён отдельно, с механикой, сценарием отказа и предполагаемой областью правки; лейбл `bug` — работающий не так код, `enhancement` — упрощения и незакрытые вопросы.

Документ при этом проблемы не прячет: они описаны по месту, в разделах о соответствующих подсистемах, и там же помечены как проблемы. Найдя новую, опишите её в профильном разделе и заведите issue — не восстанавливайте здесь сводный список, он снова протухнет.

## 18. Инварианты и подводные камни

Третий проход анализа, специально нацеленный на неявные правила, которые новый контрибьютор может нарушить, не получив предупреждения ни от имени, ни от типа, ни от структуры файлов. Некоторые из находок новые и не покрыты ни трекером, ни `docs/flows.md`; часть ссылается на эти документы, где механика уже расписана. У каждого пункта указан уровень уверенности — помеченные **(не установлено — фиксируем, а не заключаем)** действительно неоднозначны по одному лишь коду, и считать их решёнными не стоит.

### Обязательный порядок выполнения

- **`sequentialize()` обязан продолжать включать `from.id` в свой ключ, иначе открывается настоящая гонка типа check-then-act.** `FillUserToContextMiddleware` делает `existsById(id)`, а затем, по булеву результату, либо `create()`, либо `edit()` — без транзакции или блокировки строки, связывающей проверку с действием. Сегодня это безопасно только потому, что `sequentialize()` (регистрируется в `Bot.setupSequential()`, *до* composer'а с middleware) сериализует все апдейты с одинаковым `from.id`, так что два конкурентных апдейта от одного совсем нового пользователя не могут одновременно увидеть `existsById() === false`. **Это реальная несущая зависимость между двумя файлами, которые выглядят несвязанными** (вызов `sequentialize()` в `bot.ts` по соседству с `session.helper.ts` и `fill-user-to-context.middleware.ts`): удаление `from.id` из ключевой функции `sequentialize()` или перенос её после middleware заполнения пользователя вновь откроет гонку. (Upsert `ON CONFLICT DO UPDATE` в `PgSqlUserRepository.save()` означает, что гонка не может испортить данные или уронить код — в худшем случае безобидная перезапись «последний выиграл» между двумя почти одинаковыми записями, — но *задуманный* выбор ветки create/edit станет ненадёжным.)
- **Ранние вызовы `container.get(...)` внутри `Container.setup()` должны затрагивать только классы, все транзитивные зависимости которых, внедряемые через конструктор (`@inject`), уже связаны к этому моменту последовательности фаз.** `setupInfrastructureLogger()` (часть `setupInfrastructure()`, *последней* из трёх фаз `setup()`) синхронно вызывает `this.get()` для `Config`, `ConsoleLogger` и `PinoLogger`, форсируя реальное создание экземпляров, а не ленивое разрешение. Сегодня это работает лишь потому, что ни один из этих трёх классов не внедряет через конструктор ничего, связанного в более ранней фазе. Всё остальное в приложении (`Bot`, `Planner`, `Broker` и т. д.) обходит эту опасность, используя ленивые декораторы свойств `@ConfigValue`/`@PgSql` вместо раннего `.get()` — и весьма вероятно, что именно *поэтому* эти декораторы и существуют, а не просто конструкторный `@inject`: биндинг `Bot` происходит в фазе 1, а `Config` — в фазе 3. Если вы когда-нибудь добавите новый ранний `.get()` внутрь `setup()`, проверьте, что он не тянется к чему-то, связанному позже, иначе он упадёт на старте с бесполезным «no matching bindings found».
- **Миграции строго append-only и зависят от порядка** — `node-pg-migrate` отслеживает применённые миграции по имени файла/таймстемпу; правка уже применённого файла миграции никак не влияет на уже мигрировавшие базы и лишь разводит свежие базы с существующими.

### Предположения о состоянии системы

- **Успешно залогированное `"Bot is successfully started."` не означает, что Postgres доступен.** Конструктор `Database` вызывает `postgres({...})` (клиент `porsager/postgres`), который — как и большинство современных клиентов Postgres — устанавливает реальное TCP-соединение лениво, при первом запросе, а не при конструировании. Поскольку в последовательности старта до начала опроса апдейтов ни один запрос не выполняется, полностью недоступная база проявится только тогда, когда *первый* реальный апдейт попытается прочитать/записать строку сессии или пользователя (то есть потенциально сильно позже записи «successfully started» и только когда боту напишет настоящий пользователь).
- **`ctx.user` заполняется ровно один раз на апдейт, в `FillUserToContextMiddleware`, и ничто до него в пайплайне не может рассчитывать, что поле уже установлено.** Всё, что переставляет middleware выше него или работает вне обычного пайплайна апдейтов (например, будущая фоновая задача), не должно предполагать, что `ctx.user` существует.
- **Ограничитель скорости предполагает, что переменные `LIMIT_*_NUMBER` всегда положительные целые.** Если любая из `LIMIT_COMMON_NUMBER`/`LIMIT_PRIVATE_NUMBER`/`LIMIT_GROUP_NUMBER` окажется равна `0` (ошибка конфигурации, от которой ничто не защищает), `reserveDuration = interval / number` в `SlotManager` станет `Infinity`, тогда `reserveTimeout = Date.now() + Infinity`, и слот этой области **больше никогда не освободится за всё время жизни процесса** — одна резервация навсегда заблокирует все дальнейшие сообщения в этой области. На практике не наблюдалось (значения в поставляемом `.env.dist` вменяемые), но при загрузке конфигурации это никак не валидируется.

### Механизмы повторов

- Полностью описано в `docs/flows.md`, Поток 4, в `docs/architecture.md` §6 и в issue [#28](https://github.com/yuldashevsardor/telegram-bot/issues/28): перехват-и-повтор и бан по 429 в `Broker` с высокой вероятностью мертвы в рантайме из-за неожидаемого (`await`-less) Promise внутри замыкания `callback` в `TelegramCallApiMiddleware`. Здесь дана перекрёстная ссылка, потому что это ровно та ловушка «выглядит рабочим, структурно читается верно, тихо не работает», о которой призван предупреждать этот раздел. Если вы когда-нибудь почините лежащий в основе баг цепочки Promise, учтите: путь бана/повтора, насколько можно судить по этому анализу, **никогда не проверялся в production** — относитесь к нему как к непроверенному, а не «восстановленному».
- Нигде нет повторов ни для первичного подключения к Postgres, ни для `setMyCommands` при старте (§5) — оба выполняются однократно; временный сбой на старте фатален для этой подсистемы на всё время жизни процесса (или, согласно issue [#13](https://github.com/yuldashevsardor/telegram-bot/issues/13), тихо проглатывается собственным catch'ем в `Bot.run()`, оставляя процесс живым, но неработоспособным).

### Идемпотентность

- `PgSqlUserRepository.save()` и `PgsqlStorage.write()` — оба настоящие upsert'ы (`ON CONFLICT ... DO UPDATE`), поэтому повторные вызовы с теми же данными безопасны; именно на это свойство идемпотентности молча опирается описанная выше гонка check-then-act.
- `UserService.create()`, вопреки названию, **не** работает как «создать, если нет, иначе упасть» — он всегда делает upsert. Вызов для существующего пользователя молча перезаписывает `first_name`/`last_name`/`username`/`is_bot`/`last_active_time`/`updated_time` тем, что лежит в `CreateUserDto` (при этом `created_time` корректно сохраняется, так как исключён из списка колонок в `DO UPDATE SET`). На это полагаются (см. выше), а не защищаются от этого.
- `Convertor.validateToPath()` требует, чтобы путь назначения **не** существовал (иначе бросает `InvalidPath.isAlreadyExists`) — то есть конвертация шрифта не является безопасной к перезаписи/идемпотентной операцией; повторный вызов с тем же сгенерированным случайным именем упал бы на второй попытке. На практике коллизий не бывает, поскольку имена файлов заново рандомизируются на каждый вызов, но операция намеренно неидемпотентна по пути.

### Особые и граничные случаи

- `Planner.ban(duration)`: `duration`, равный ровно `0`, даёт `expirationTime = Date.now()`, и проверка `if (expirationTime < Date.now()) return;` на практике почти всегда окажется истинной к моменту выполнения (даже субмиллисекундного зазора хватает, чтобы `Date.now()` сдвинулся вперёд) — то есть бан нулевой длительности молча ничего не делает. **(не установлено — фиксируем, а не заключаем)**: читается как, вероятно, намеренное («бан на 0 мс — это отсутствие бана», что разумно), но и очевидно преднамеренным из кода не выглядит.
- В `TelegramCallApiMiddleware` условие `isGroup = chatId < 0` трактует `chatId === 0` и не как группу, и не как исключение из очереди для приватных чатов — Telegram никогда не присылает `chat_id: 0`, так что наблюдаемого эффекта нет, но и явной обработки на случай, если это предположение когда-нибудь окажется неверным, тоже нет.
- Исходящий payload, не являющийся простым объектом (например, тело multipart/загрузки файла), полностью минует очередь ограничения скорости (ветка `payload.constructor.name !== "Object"` в `TelegramCallApiMiddleware`) — уже отмечено в `docs/flows.md`, Поток 4, повторено здесь, потому что это легко упустить, если будущая фича добавит настоящие загрузки файлов: такие отправки существующим механизмом не будут ограничиваться вовсе.

### Неявная связность между модулями

- **Enum `Level` в `domain/logger/logger.types.ts` и объект числового маппинга `pinoLevels` в `infrastructure/logger/pino.logger.ts` — два независимо поддерживаемых вручную источника истины**, синхронизируемых лишь по договорённости (оба перечисляют те же пять имён уровней); система типов это никак не обеспечивает. Добавление нового `Level` без соответствующей записи в `pinoLevels` (с числовым значением строго между соседними уровнями, поскольку pino требует возрастающих значений) прекрасно скомпилируется и упадёт в рантайме при первом же логировании этого уровня через `PinoLogger`.
- **Добавление нового отслеживаемого поля из `ctx.from` в Telegram (например, `language_code`) требует синхронного изменения четырёх файлов, и компилятор их между собой не связывает ничем, кроме формы самого DTO:** `user.types.ts` (`UserDto`/`UserRow`/`CreateUserDto`/`EditUserDto`), `user.ts` (поле сущности + геттер/сеттер), соответствующая миграция (новая колонка) — и, отдельно, мапперы `rowToEntity`/`entityToRow` в `pgsql.user.repository.ts`, а также ручной маппинг поле-за-полем из `ctx.from` в `fill-user-to-context.middleware.ts`. TypeScript спокойно скомпилирует код, если вы забудете миграцию (несоответствие проявится только рантайм-ошибкой SQL «column does not exist» при следующем upsert'е).
- **`config.logger.default` (env `LOGGER_DEFAULT`) не просто выбирает логгер — он молча определяет, работает ли вообще коррелированное по запросам логирование (`AsyncLocalStorageMiddleware`)**, поскольку единственное, что его включает, — проверка `instanceof PinoLogger` в этом middleware. Переключение логгера по умолчанию на `ConsoleLogger` (дефолт для разработки) меняет не только форматирование, но и полностью убирает корреляцию запросов — неочевидно из любого файла по отдельности (`config.ts` и `async-local-storage.middleware.ts` не ссылаются друг на друга; связь существует только через связывание в контейнере в `setupInfrastructureLogger()`).
- **Порядок колонок в миграции и позиционный `INSERT ... VALUES (key, value)` (без явного списка колонок) в `PgsqlStorage.write()` неявно связаны** — подробно описано в `docs/architecture.md` §11/§16; повторено здесь как пример «меняешь одно — тихо ломается другое»: перестановка колонок в миграции `sessions` (или добавление новой обязательной колонки перед `created_time`) молча перепутает значения или сломает вставку, причём в самом `pgsql.storage.ts` ничто на эту зависимость не намекает.

### Необычная валидация

- Валидация MIME для файлов шрифтов (`Convertor.validateFromPath`) выводит «MIME-тип» из **расширения** файла через пакет `mime-types` (`mime.lookup(extension)`), а не из содержимого — то есть, хотя читается как проверка content-type, на деле это лишь «выглядит ли это расширение правдоподобным для данной схемы». Повреждённый или вредоносный файл с правильным расширением проходит. Закомментированный блок анализа содержимого (§7) показывает, что когда-то это, видимо, задумывалось строже.
- `getMimeType()` в `FileHelper` бросает `PermissionDenied.write(path)`, когда файл *недоступен для чтения*, — тип и сообщение ошибки говорят «write» там, где на деле проверяются права на *чтение*. **(не установлено — фиксируем, а не заключаем)**: похоже на ошибку копипасты (в том же файле есть идентичный, корректно помеченный `PermissionDenied.read`), но, поскольку сам `getMimeType()` достижим только из закомментированного мёртвого кода в `convertor.ts`, живого эффекта это не имеет.

### Предположения о конкурентности

- Ключевая функция `sequentialize()` возвращает `[chat.id, from.id]` как два независимых ключа (а не один составной) — для **приватного** чата соглашение Telegram делает `chat.id === from.id` численно, так что обе записи дают одну и ту же строку; безвредно (избыточная блокировка по одному ключу), но об этом стоит знать, чтобы не принять за баг. Для **групповых** чатов (сейчас недостижимых за `IsPrivateChatFilter`, хотя конфигурация рейт-лимитов для групп существует — см. §6) значения различались бы, и апдейты пользователя из двух разных чатов всё равно сериализовались бы друг относительно друга по общему ключу `from.id`, а не только внутри одного чата. Это необходимо для описанной выше свободы от гонки `existsById`/`create`/`edit`, а не случайный побочный эффект.
- Сам DI-контейнер — единственный **глобальный** синглтон на уровне модуля (`export const container = new Container()` в `container.ts`), и декораторы `@ConfigValue`/`@PgSql` лезут в него напрямую (`import { container } from "app/infrastructure/container/container"`), а не через конструкторное внедрение. **Это означает, что любой класс, использующий эти декораторы, невозможно изолировать для юнит-теста через отдельный экземпляр `Container`** — он всегда будет читать из единственного глобального контейнера, что бы ни собрал тестовый сетап. Это не живой баг (в (почти отсутствующем) наборе тестов такого никто не пробует), но реальное ограничение тестируемости этих классов без отказа от паттерна декораторов.
- Декораторы свойств (`ConfigValue`, `PgSql`) замыкаются на единственную переменную `value`/`sql`, определяемую **один раз, в момент определения класса**, и через `Object.defineProperty` вешают геттер на **прототип класса** (`target` у декоратора свойства — это прототип, а не объект экземпляра), так что закэшированное значение **разделяется всеми экземплярами класса**, а не кэшируется на каждый экземпляр. Сегодня это безвредно, поскольку каждый класс, использующий эти декораторы, связан как `.inSingletonScope()` в `container.ts` (проверено — `StartConversation` является единственным несинглтонным биндингом во всём контейнере и не использует ни один из декораторов). **(не установлено — фиксируем как мину, а не как живой баг)**: если будущему несинглтонному классу дадут свойство `@ConfigValue`/`@PgSql`, все экземпляры молча разделят одно закэшированное разрешение вместо того, чтобы разрешать его независимо, — что неожиданно, ведь ничто в названии декоратора не намекает на разделение на уровне прототипа.

### Обратная совместимость

- `User.id` и `Message.chatId` представлены обычным JS-типом `number` во всех доменных и инфраструктурных слоях, тогда как лежащая под ними колонка `users.id` имеет тип `bigint` (расширена с `integer` именно потому, что ID Telegram вышли за 32-битный диапазон — §11). JS `number` точен только до `2^53 - 1`; текущие ID Telegram с запасом укладываются в этот диапазон, но сам выбор типа не защищает от будущей схемы ID, которая туда не уложится. Это не активная проблема, но об этом стоит знать, прежде чем считать, что `bigint` в Postgres означает полную точность на всём пути.

### Магические константы

Неполный каталог захардкоженных значений, не оформленных именованными константами; собран здесь, поскольку об них легко споткнуться при рефакторинге соседнего кода: интервал опроса в `Bot.waitPlannerToEmpty` (`3000` мс, захардкожен, не настраивается через env); интервал отчётов `Planner.logMessageCount`/`logBanExpires` (по `10000` мс, два отдельных вызова `setInterval` с одним и тем же захардкоженным значением, без общей константы); `StringHelper.generateRandomString(15)` для временных имён файлов шрифтов; числа кастомных уровней pino (`debug=0, info=100, warning=200, error=300, critical=400` в `pino.logger.ts`) — см. пункт про неявную связность выше; и три захардкоженных chat ID плюс границы циклов `100_000`/`1` в `BulkMessagesCommand`/`FontGeneratorCommand` (описаны в §5/§7 как отладочные остатки, а не «настоящие» магические константы в конфигурационном смысле, но помнить, что это захардкоженные литералы, а не конфиг, стоит).

### Логика, которая выглядит странно, но, вероятно, намеренна

- Скан-с-пропуском за O(n) в `Planner.pullByPriority` (вместо строгого FIFO) внутри каждой приоритетной корзины — намеренно избегает блокировки головы очереди, когда чат первого сообщения зажат рейт-лимитом. Подтверждено как здравый дизайн, а не баг, несмотря на нарушение наивного ожидания, что очередь отдаёт в порядке вставки.
- Обширные русскоязычные комментарии, разбросанные по самым хитрым местам кода (в первую очередь у Proxy-хака в `TelegramCallApiMiddleware`), фактически являются самым близким к обоснованию дизайна, что есть в этой кодовой базе для её наименее очевидного механизма, — их стоит прочитать, даже если русский вам иначе не нужен, поскольку они объясняют, *почему* хак существует, а не только что он делает.
- `RequestLogMiddleware` инкрементирует `session.requestCount` на каждом апдейте, а получившийся счётчик нигде в кодовой базе не читается и не отображается. **(не установлено — фиксируем, а не заключаем)**: это могут быть заготовки под будущую пользовательскую аналитику или обнаружение злоупотреблений — а может быть мёртвая инструментация, оставшаяся с прежних этапов разработки; код не даёт понять, что именно.
