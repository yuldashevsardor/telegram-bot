# Архитектура

Документ описывает код таким, какой он есть, включая известные проблемы: они помечены
по месту ссылкой на issue. Найдя новую проблему, опишите её в разделе подсистемы и
заведите issue; сводного списка проблем здесь нет намеренно, он в трекере.

Рантайм-последовательности (старт, остановка, апдейт, исходящий вызов, команды) —
в [`docs/flows.md`](./flows.md).

## 1. Обзор

Назначение — конвертация шрифтов между форматами (`src/domain/font-convertor/`, §7).
Telegram — способ доставки; `User`, сессии и миграции существуют ради Telegram-фронтенда.

Стек:

- **grammY** + `@grammyjs/runner` (long polling, конкурентная обработка апдейтов)
  + `@grammyjs/conversations`.
- **inversify** — DI, биндинги вручную.
- **PostgreSQL** — клиент `postgres` (porsager) в рантайме, `node-pg-migrate` для миграций.
- **pino** в production, `console` в остальных режимах — за доменным интерфейсом `Logger`.
- **FontForge** — внешний CLI.
- **Fluent** (`@moebius/fluent` + `@grammyjs/fluent`) — i18n, фактически только русский.

Слои: `domain/` — логика и порты, `infrastructure/` — адаптеры, `common/` — сквозные
типы и базовая ошибка, `helper/` — утилиты. Разделение последовательно у `user` и
`logger`; `task-queue` порта почти не имеет, потому что внешней системы за ним нет.

Ошибки: наружу бросается `RuntimeError` (`common/errors.ts`) или его подкласс из
`<модуль>.errors.ts` рядом с бросающим кодом — `font-convertor`, `font-forge`, `logger`,
`user`, `rate-limit`, `runner`, `file-helper`, `string-helper`, плюс `InvalidConfigError`
в `common/`. Конструктор — `new RuntimeError(message, payloadOrCause)`: `Error` вторым
аргументом уходит в стандартный `cause`, объект — в `payload` (поле `cause` внутри него
дополнительно попадает в `cause`). Детали собирают статические фабрики по месту
(`ExtensionNotSupport.byExtension()`). Чужую ошибку без своих деталей оборачивает
`byError()` — он берёт её message и кладёт её саму в `cause`; если нужен ещё и payload,
ошибка передаётся полем `cause` внутри него (`UserService.create()`).

Команды бота: `/start` — conversation с приветствием; `/font_generator` — отладочная
конвертация фиксированного файла, путь результата уходит текстом (§7);
`/bulk_messages` — нагрузочный инструмент, а не фича (issue
[#3](https://github.com/yuldashevsardor/telegram-bot/issues/3)).

## 2. Карта директорий

```
src/
  app.ts                    точка входа: new Application(), сигналы, fail()
  common/                   RuntimeError и сквозные типы
  domain/
    task-queue/             очередь исходящих по ключам, лимиты, цикл Runner (§6)
    font-convertor/         конвертация шрифтов (§7)
    user/                   сущность, порт репозитория, сервис (§8)
    logger/                 интерфейс Logger, enum Level (§9)
  helper/                   string/number/file/utils (sleep, withTimeout)
  infrastructure/
    application/            Application: сборка и жизненный цикл (§4)
    bot/                    grammY: команды, conversations, middleware, фильтры, сессия (§5)
    config/                 ConfigStorage → ConfigContainer (§12)
    container/              inversify-контейнер и символы (§3)
    database/               Database (§11)
    logger/                 ConsoleLogger, PinoLogger (§9)
    repository/             PgSqlUserRepository (§8)
    async-local-storage.ts  общий AsyncLocalStorage для per-request логгера (§9)
test/                       mocha-спеки, зеркалят src/
migrations/                 миграции, в common/ — общие shorthands и заготовка (§11)
scripts/                    worktree-init/cleanup, bot-token, db-reset, claude-worktree-guard
```

Импорты только через алиас `app/*` (`tsconfig.json` + `tsc-alias`), относительные
запрещены ESLint-правилом `no-restricted-imports`. Исключение — каталог `migrations/`:
он лежит вне `src/`, алиас туда не ведёт, и правило снято на весь каталог через
`overrides` в `.eslintrc.js`.

## 3. DI

`Container extends InversifyContainer` (`container/container.ts`), `setup(config, logger)`
идемпотентен. Конфиг и логгер приходят готовыми из `Application` и связываются первыми
константами, затем `setupModules()` (лимит-резолвер, очередь, раннер, всё из
`setupBot()`), `setupServices()` (font-convertor, user), `setupInfrastructure()`
(`Database`). Всё singleton, кроме `StartConversation`.

Символы — `Symbol.for(...)` в `container/symbols/` (`Infrastructure`, `Modules`,
`Services`). Реестр ручной: новая команда, middleware или сервис без биндинга не
падает, а просто отсутствует.

Два декоратора свойств тянут значения из модульного синглтона `container` при первом
обращении (service locator): `@ConfigValue(key)` — путь в `ConfigContainer`
(`"bot.token"`), `@PgSql()` — `Database.sql`. Геттер вешается на прототип, значение
одно на класс: для несинглтонного класса все экземпляры разделят его. Замена на
конструкторное внедрение — issue [#41](https://github.com/yuldashevsardor/telegram-bot/issues/41).

`Container.close()` закрывает пул Postgres и сбрасывает `alreadySetup`, но биндинги не
снимает: повторный `setup()` в том же процессе упал бы на дублях.

## 4. Application

`Application` (`infrastructure/application/application.ts`) — единственное место сборки
и жизненного цикла; создаётся `new` в `app.ts`, в контейнере не значится.

- `setup()`: `ConfigContainer(ConfigEnvStorage)` → `createLogger()` → `container.setup()`
  → `Database.check()` (`select 1`, недоступная база валит старт) → `Bot.setup()`.
  Конфиг собирается до логгера, поэтому `InvalidConfigError` печатает `fail()` через
  `console.error`.
- `run()`: `runner.run()` → `bot.run()`. Ошибка пишется `critical` и пробрасывается;
  `bootstrap().catch(fail)` завершает процесс кодом 1.
- `stop()`: `bot.stop()` → `waitQueueToEmpty()` → `runner.stop()` → `container.close()`.
  Три срока: `BOT_GRACEFUL_SHUTDOWN_TIMEOUT` (3 с) на runner внутри `Bot.stop()`,
  `TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT` (5 с) на разгрузку очереди,
  `GRACEFUL_SHUTDOWN_TIMEOUT` (15 с) на всё. Общий обязан быть больше суммы частных
  (`ConfigContainer` проверяет) и меньше `stop_grace_period: 20s` контейнера. По истечении
  общего `stop()` перестаёт ждать, пишет `warning`, и `app.ts` делает `process.exit(0)`.
  Собственные сроки зависимостей (`sql.end({ timeout: 5 })`) в проверку не входят.

`createLogger()`: в production `PinoLogger`, обёрнутый в `Proxy`, который на каждый
доступ к свойству подставляет логгер запроса из `asyncLocalStorage` (§9); иначе
`ConsoleLogger`. Снять `Proxy` — issue [#40](https://github.com/yuldashevsardor/telegram-bot/issues/40).

## 5. Bot

`Bot` (`infrastructure/bot/bot.ts`) оборачивает `grammy.Bot<Context>` и знает только
Telegram-слой. `Context` = `GrammyContext & SessionFlavor<SessionPayload> &
ConversationFlavor & FluentContextFlavor & { user: User }`.

`Bot.setup()` собирает пайплайн строго в этом порядке:

1. `session()` — ключ `${from.id}:${chat.id}`, хранилище `PgsqlStorage` (таблица
   `sessions`), payload `{ requestCount }`.
2. `sequentialize()` по ключам `[chat.id, from.id]` — сериализует апдейты одного
   чата/пользователя, иначе конкурентный runner устроил бы гонку по сессии и по
   check-then-act в `FillUserToContextMiddleware` (§8).
3. Middleware: `TelegramCallApiMiddleware` → `AsyncLocalStorageMiddleware` →
   `ResponseTimeMiddleware` → `RequestLogMiddleware` → `FillUserToContextMiddleware`.
4. Fluent (§10).
5. `IsPrivateChatFilter` — всё ниже работает только в приватных чатах.
6. `conversations()` + `createConversation` для каждого символа `Modules.Bot.Conversations`.
7. Команды из `Modules.Bot.Command`: `command.setup(composer)`, затем
   `api.setMyCommands(commands)` — сетевой вызов при каждом старте.

`Bot.run()` вешает `grammy.catch(handleError)` (только `critical`-лог, пользователю
ничего не отвечается) и запускает `run(grammy)` из `@grammyjs/runner`. `Bot.stop()`
останавливает runner в пределах своего срока.

`Command`, `Filter`, `Middleware`, `ConversationHandler` — абстрактные базы вида
«`handle`/`run` + `setup(composer)`».

### TelegramCallApiMiddleware

`middleware/mutation/telegram-call-api.middleware.ts` подменяет `ctx.api.raw` на
`Proxy`. Вызов с payload-объектом, содержащим `chat_id`, превращается в задачу
`TaskQueue` (ключ — `chat_id`, приоритет `MEDIUM`, `priorityOnError: HIGH`), а
вызывающая сторона получает Promise, который резолвится/реджектится по итогу реального
вызова. Мимо очереди идут: payload не простой объект (multipart-загрузка файла), нет
`chat_id`, `chat_id` не число, и методы из `TELEGRAM_NO_GROUP_RATE_LIMIT_SET` — только
для групповых чатов.

grammY создаёт новый `Api` на каждый апдейт, поэтому обёртка не накапливается и не
касается `bot.grammy.api`: код, вызывающий его напрямую (`BulkMessagesCommand`), кладёт
задачу в очередь сам.

## 6. Очередь исходящих (TaskQueue / Partition / Runner)

Ограничивает темп исходящих вызовов Telegram. О Telegram знает минимум: работает с
задачами по произвольному ключу; телеграмное — `telegram-error.ts` в домене (коды, по
которым `Runner` опознаёт 429) и `TelegramLimitResolver` с `isGroupChat` в
инфраструктуре (отрицательный chat ID — группа).

```
push(task, priority) → Partition ключа (заводится по первой задаче; лимит ключа
                        один раз спрашивается у LimitResolver) + индекс keysByPriority
pull()               → 0. снять с головы idleKeys партиции, которые пусты и остыли
                       1. null при паузе после 429, пустой очереди или занятом общем лимите
                       2. HIGH → MEDIUM → LOW; внутри приоритета — первый ключ, чей лимит остыл
                       3. Partition.take() отдаёт голову корзины и резервирует лимит ключа,
                          TaskQueue резервирует общий лимит
Runner               → цикл на setTimeout: pull(), выполнить callback, не дожидаясь,
                       следующая итерация через setTimeout(0); при пустом pull — сон
                       RUNNER_SLEEP_INTERVAL
```

- **`TaskQueue`**: `Map<key, Partition>`, индекс `keysByPriority` (три `Set`), `idleKeys`,
  общий `RateLimit`, метка паузы. Порядок не строгий FIFO: ключ под лимитом
  пропускается. Отдавший ключ переставляется в хвост `Set`, иначе при дефолтных
  лимитах обслуживались бы только первые десять ключей. Приоритет глобальный.
- **`Partition`**: три корзины по приоритетам (внутри FIFO) и свой `RateLimit`;
  резервация внутри `take()`.
- **`RateLimit`**: один слот с остыванием `interval / number`, не token bucket.
  `reserve()` при занятом слоте бросает `RateLimitIsBusy`. `number = 0` даёт
  бесконечное остывание, конфиг это не проверяет.
- **Жизнь партиции**: удаляется, когда пуста и остыла. Пустоту очередь видит в
  `take()`, ключ уходит в `idleKeys`; остывание проверяет следующий `pull()`, обход
  обрывается на первой остывающей, не больше `REMOVED_PARTITIONS_PER_PULL` (100) за
  вызов. Удалять по одной пустоте нельзя: пока идёт остывание, партиция и есть лимит
  ключа.
- **Ошибки**: `Runner.handleTask` ловит отказ `callback`, логирует, при 429 ставит
  `TaskQueue.ban(retry_after)` (нечитаемый `retry_after` → `DEFAULT_RETRY_AFTER_SECONDS`),
  и возвращает задачу с `priorityOnError`, пока `retryCount` ≤ `RUNNER_MAX_RETRIES`.
  Вызывающая сторона видит первый отказ, а не итог повторов: иначе `ctx.reply()` висел
  бы всю паузу. Путь бана и повтора проверен вручную, автотестов нет.

Лимиты по умолчанию (`.env.dist`, рекомендации Telegram): common 30/1 с, private
3/1 с, group 20/60 с. `RUNNER_SLEEP_INTERVAL` в коде 1000 мс, в `.env.dist` — 10.

## 7. Конвертация шрифтов

```
FontConvertor.convert({ originPath, extension })
  → prepare(): tempDir существует, читаем, доступен на запись
  → расширение исходника ≠ целевому, иначе FontConvertorError
  → имя: 15 случайных символов + расширение, каталог tempDir/YYYY/M/D
  → ConvertorFactory.get(from, to): по классу на пару, convertor/<from>/<from>-to-<to>.ts
  → Convertor.validate(): исходник существует и читаем, расширение совпадает, MIME по
    расширению (mime-types) в allowedMimeTypes; путь назначения не существует
  → FontForge.convert(): fontforge -c 'import fontforge; font = fontforge.open("SRC");
    font.generate("DIST")' через child_process.exec
```

Известное:

- Команда собирается `.replace()` без экранирования (issue
  [#34](https://github.com/yuldashevsardor/telegram-bot/issues/34)); пути сейчас
  внутренние случайные.
- `SVG` объявлен в `FontForge.supportedExtensions`, пар для него нет: `ConvertorNotFound`
  (issue [#35](https://github.com/yuldashevsardor/telegram-bot/issues/35)).
- MIME проверяется по расширению, содержимое не читается; блок проверки по содержимому
  закомментирован в `convertor.ts`.
- Временные файлы не удаляются (issue
  [#37](https://github.com/yuldashevsardor/telegram-bot/issues/37)).
- `/font_generator` конвертирует фиксированный `tempDir/app/test-fonts/test-font.woff` в
  EOT/OTF/TTF/WOFF2 и отвечает **путём** к файлу текстом; сам файл не отправляется.
  Ошибки уходят в `console.log`, мимо `Logger`.

## 8. User

`domain/user/`: сущность `User` с приватными полями и сеттерами, которые проставляют
`updatedTime`; порт `UserRepository` (`getById`, `existsById`, `save`, `delete`);
`UserService.create()`/`edit()` с обёрткой ошибок в `UserCreateError`/`UserEditError`.
`PgSqlUserRepository.save()` — upsert `on conflict (id) do update`.

`FillUserToContextMiddleware` на каждом апдейте: `existsById` → `edit` (с
`lastActiveTime = now`) или `create` → `ctx.user`. Проверка и действие не связаны
транзакцией; от гонки защищает только `sequentialize()` по `from.id` (§5).
`create()` не защищает от дублей сам — полагается на upsert.

Защита `if (!ctx.from)` в этом middleware недостижима: апдейт без `from` падает раньше,
в `RequestLogMiddleware`, на обращении к `ctx.session` при неразрешённом ключе (issue
[#29](https://github.com/yuldashevsardor/telegram-bot/issues/29)).
`RequestLogMiddleware` также логирует весь `ctx.update` на `debug` и инкрементирует
`session.requestCount`, который нигде не читается. `UserAlreadyExists` не бросается
(issue [#38](https://github.com/yuldashevsardor/telegram-bot/issues/38)).

## 9. Логирование

Порт `domain/logger/logger.ts` (`critical/error/warning/info/debug(message, payload?)`),
`Level` и веса `LevelSeverity` в `logger.types.ts`. Адаптеры в `infrastructure/logger/`:
`AbstractLogger` (порог через `setLevel`, `isEnabled`), `ConsoleLogger`, `PinoLogger`
(кастомные уровни из `LevelSeverity`, `child(context)`).

Порог — `LOGGER_LEVEL`: пишется он и всё серьёзнее; по умолчанию `WARNING` в production,
`DEBUG` иначе. Неизвестное значение — `InvalidConfigError`.

Корреляция запросов: `AsyncLocalStorageMiddleware` создаёт `child({ requestId })` и
выполняет остаток пайплайна в `asyncLocalStorage.run()`, а `Proxy` из
`Application.createLogger()` подставляет его при каждом обращении к логгеру. Работает
только с `PinoLogger`, то есть только в production; в разработке корреляции нет.

Payload перед записью проходит через `serialize-error`: без него вложенная ошибка
печаталась бы как `{}`, а так в лог попадают её `name`, `message`, `stack` и `cause`.

При добавлении уровня править три места: `Level`, `LevelSeverity` и `pinoLevels` в
`pino-logger.ts`; последний — `Record<PinoLevel, number>` по строковому имени, забытая
запись упадёт в рантайме.

## 10. i18n

`Bot.setupFlavor()` собирает все `.ftl` под `src/infrastructure/bot`, локаль берёт из
имени по соглашению `*.locale.<lang>.ftl` (предпоследний сегмент, без валидации) и
регистрирует в `Fluent`. `localeNegotiator` всегда возвращает `"ru"`.

Файл один: `start.conversation.locale.ru.ftl` с ключом `welcome`. `StartConversation`
рядом использует захардкоженную русскую строку мимо Fluent. Довести i18n — issue
[#6](https://github.com/yuldashevsardor/telegram-bot/issues/6); в приветствии потерян
EOT — issue [#27](https://github.com/yuldashevsardor/telegram-bot/issues/27).

`tsc` не копирует `.ftl` в `build/`, запуск из `build/` падает — issue
[#19](https://github.com/yuldashevsardor/telegram-bot/issues/19); контейнер работает
через `npm run dev`.

## 11. Хранение данных

`Database` (`infrastructure/database/database.ts`) оборачивает `postgres`; пул создаётся
в конструкторе, соединение открывается лениво, поэтому `Application.setup()` делает
`check()`. `debug: !isProduction` включает лог запросов вне production.

Миграции — `node-pg-migrate` (`migrate.json`, каталог `migrations/` в корне),
накатываются тем же контейнером перед стартом бота. Три файла: `users`, `sessions`,
расширение `users.id` до `bigint`. Миграции append-only.

Каталог лежит вне `src/` намеренно: приложение миграции не импортирует, грузит их
`node-pg-migrate` своим jiti прямо из исходников, и в `build/` они были мёртвым грузом.
Проверки их всё равно видят — `migrations/**/*.ts` перечислен в `tsconfig.check.json`,
`npm run lint` и `format:check`.

`common/template.ts` — заготовка, из которой `migrate-create` делает файл миграции.
Лежит в подкаталоге, и этого достаточно, чтобы `node-pg-migrate` её не видел: каталог
миграций он читает без рекурсии и подкаталоги пропускает (поэтому и `ignore-pattern` в
`migrate.json` не нужен). Её импорт `./common/utils` рассчитан не на её собственное
место, а на каталог, куда её скопируют.

Из проверок она исключена в одном месте — `exclude` в `tsconfig.check.json`: `pgm` в ней
объявлен, но не используется, и импорт с её места не резолвится. Ту же заглушку для eslint
несёт первая строка самого файла, и оттуда она копируется в создаваемую миграцию, где
нужна по той же причине. Расширение `.ts` обязательно: `node-pg-migrate` берёт из имени
заготовки расширение создаваемого файла.

`sessions` пишется из `PgsqlStorage` напрямую позиционным `insert into sessions values
(key, value)` — порядок колонок в миграции и этот запрос связаны молча. Репозиторий
есть только у `users` (issue [#43](https://github.com/yuldashevsardor/telegram-bot/issues/43)).

`User.id` — JS `number` при `bigint` в базе; точность до `2^53 - 1`, текущие ID Telegram
укладываются.

## 12. Конфигурация

`ConfigStorage` (`get(key)`) → `ConfigEnvStorage` (`dotenv` в конструкторе, читает
`process.env`) → `ConfigContainer` разбирает и валидирует всё сразу и раздаёт секциями
(`bot`, `database`, `logger`, `runner`, `limits`, `gracefulShutdown`, `taskQueue`).
Раскрытия `${...}` в `.env` нет. Тесты подкладывают фейковый сторедж.

| Переменная | Назначение (по умолчанию) |
|---|---|
| `NODE_ENV` | `production` включает `PinoLogger` и порог `WARNING` (`development`) |
| `BOT_TOKEN` | обязательна |
| `TEMP_DIR` | временные файлы конвертации (`<root>/tmp`) |
| `FONT_FORGE_PATH` | бинарник FontForge (`fontforge`) |
| `LIMIT_{COMMON,PRIVATE,GROUP}_{NUMBER,INTERVAL}` | лимиты §6 (30/1000, 3/1000, 20/60000) |
| `RUNNER_SLEEP_INTERVAL` | сон при пустой очереди, мс (1000; в `.env.dist` 10) |
| `RUNNER_MAX_RETRIES` | повторов задачи до отбрасывания (3) |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | общий срок остановки (15000), больше суммы двух ниже |
| `BOT_GRACEFUL_SHUTDOWN_TIMEOUT` | остановка runner'а бота (3000) |
| `TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT` | разгрузка очереди (5000), `0` — не ждать |
| `TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL` | шаг опроса очереди (500), больше нуля |
| `LOGGER_LEVEL` | порог логирования |
| `DATABASE_HOST/PORT/NAME/USER_NAME/USER_PASSWORD` | подключение; внутри compose host/port задаёт `docker-compose.app.yml` |
| `DATABASE_CONNECTION_LIMIT/IDLE_TIMEOUT/MAX_LIFETIME` | пул (10, 10 с, 600 с) |

`DATABASE_SUPERUSER_*`, `DATABASE_TIMEZONE`, `DATABASE_DATE_STYLE` читает только
`docker-compose.db.yml`. `DATABASE_URL` — только `node-pg-migrate`, собирается в
`docker-compose.app.yml`.

В истории git есть старый `BOT_TOKEN` в `.env.dist`; он отозван и мёртв, историю не
переписывали (issue [#36](https://github.com/yuldashevsardor/telegram-bot/issues/36)).
От повторной утечки защищает secret scanning с push protection на GitHub.

## 13. Тесты и проверки

- `mocha` через `.mocharc.json` (`ts-node/register` + `tsconfig-paths/register`, без него
  алиас `app/*` не разрешается). Типы тестов проверяет `npm run typecheck` по
  `tsconfig.check.json`: сборочный `tsconfig.json` ограничен `src`.
- Покрыто: `task-queue` (очередь, партиция, лимит), `ConfigContainer`,
  `ConfigEnvStorage`, `ConsoleLogger`, `FileHelper`, `utils`, `errors`. Не покрыто:
  `Runner`, `FontConvertor`, `UserService`, `Application`, `Bot`, middleware.
- `nyc` считает покрытие по TypeScript-исходникам; отчёт в `./coverage`.
- `tsconfig.json`: `strict` и все флаги вне его зонтика; `skipLibCheck` вынужденно
  (issue [#5](https://github.com/yuldashevsardor/telegram-bot/issues/5)). ESLint: без
  `any`, неиспользуемые аргументы только с `_`.
- Husky `pre-commit` → `lint-staged` (`eslint --fix`, `prettier --write`) — удобство
  хостовой разработки, не гейт: хук ставит `package.json#prepare` при `npm install` на
  хосте. В docker-first окружении его нет намеренно — `npm ci --ignore-scripts` и
  `HUSKY=0` в `Dockerfile`, а `.git` в контейнер не монтируется; сам хук пропускает себя,
  если node в hook-окружении недоступен. Обязательный гейт — CI, его пока нет (issue
  [#116](https://github.com/yuldashevsardor/telegram-bot/issues/116)).
- `.claude/settings.json` вешает `scripts/claude-worktree-guard.sh` на старт сессии и
  на `Edit|Write`: правка файла в основном дереве отклоняется. Правки через shell хук
  не видит.

## 14. Инварианты

Правила, которые не проверяются ни типами, ни тестами; `CLAUDE.md` отсылает сюда перед
правкой затронутых мест.

- **`sequentialize()` включает `from.id`.** Без этого два первых апдейта нового
  пользователя оба увидят `existsById() === false`. Данные не испортятся (upsert), но
  выбор ветки `create`/`edit` станет ненадёжным.
- **Миграции append-only.** `node-pg-migrate` отслеживает применённые по имени файла;
  правка старого файла разводит свежие базы с существующими.
- **Ручная регистрация в DI.** Новый класс не появится в пайплайне, пока его нет в
  `container.ts` и `symbols/`.
- **`ctx.api` против `bot.grammy.api`.** Перехват очереди живёт только на `ctx.api`
  текущего апдейта. Прямой вызов `bot.grammy.api` и любой multipart-payload идут мимо
  лимитов.
- **`ctx.user` есть только после `FillUserToContextMiddleware`.** Код выше по пайплайну
  или вне его (будущие фоновые задачи) на поле рассчитывать не может.
- **Сроки остановки**: общий > сумма частных (проверяется), общий <
  `stop_grace_period` контейнера (не проверяется).
- **`LIMIT_*_NUMBER > 0`.** Ноль → `reserveDuration = Infinity` → слот занят навсегда,
  партиция никогда не удалится.
- **Новое поле пользователя из `ctx.from`** требует синхронной правки `user.types.ts`,
  `user.ts`, миграции, мапперов в `pgsql-user-repository.ts` и
  `fill-user-to-context.middleware.ts`; компилятор их не связывает, забытая миграция
  проявится SQL-ошибкой в рантайме.
- **Порядок колонок `sessions`** связан с позиционным `insert` в `PgsqlStorage.write()`.
- **`NODE_ENV` решает, есть ли корреляция запросов** (§9), а не только формат логов.
- **`.ftl` именуются `*.locale.<lang>.ftl`**; иначе парсер имени выдаст фиктивную локаль.
- **`Convertor.validateToPath()` требует несуществующий путь**: конвертация не
  идемпотентна по пути, имя генерируется заново на каждый вызов.
- **`Runner.run()`/`stop()` синхронные**, хотя вызываются с `await`; `stop()`
  не ждёт конца текущей итерации цикла.
