# Конфигурация

Конфигурация живёт в `bootstrap/config/`. `ConfigContainer<Values>` (`config-container.ts`)
получает в конструкторе `ConfigStorage` и `ConfigBuilder<Values>` и собирает значения в
`init()`: storage одним вызовом `load()` отдаёт снимок всех переменных (`RawConfig`), builder
разбирает и проверяет его и возвращает `Values`, контейнер их хранит и раздаёт методом
`get("bot.token")`. `get()` до `init()` — `ConfigContainerIsNotInitialized`. В приложении
это `CC` — `ConfigContainer<ConfigValues>` со `ConfigEnvStorage` и `ConfigValuesBuilder`,
его собирает `ApplicationContext.create()` ([`application.md`](./application.md)). Раскрытия
`${...}` в `.env` нет.

`init()` и `load()` асинхронные, хотя env отдаёт переменные сразу: следующие источники (файл,
vault) ходят за значениями вне процесса, и интерфейс под них не придётся менять. Storage
держит сам контейнер, а не отдаёт ему готовый снимок: источнику предстоит сообщать об
изменениях, и пересобирать значения по ним будет контейнер. `ConfigEnvStorage.load()` зовёт
`dotenv.config()` и отдаёт копию `process.env`, а не сам объект: сборка видит переменные на
момент загрузки.

`ConfigValuesBuilder` (`builder/config-values-builder.ts`) — схема приложения: какие
переменные, с какими умолчаниями и диапазонами. На каждый `build()` он заводит
`ConfigParser` (`parser/config-parser.ts`) на переданный снимок, и тот разбирает строки
строго: умолчание подставляется только вместо отсутствующей или пустой переменной, а
заданное, но недопустимое значение валит старт `InvalidConfigError` с именем переменной, а не
превращается в умолчание. Строка без умолчания обязательна, целое читается только с
диапазоном. Сроки и периоды в миллисекундах, которые уходят в таймеры Node, читает
`getTimerDelay`: не больше 2147483647 мс, потому что большее значение Node превращает в
1 мс, и срок, взятый «на никогда», срабатывает сразу; сроки пула в секундах читает
`getInteger` со своим потолком (таблица ниже). Проверки, связывающие несколько переменных,
остаются в `ConfigValuesBuilder`. Хелперы разбора — публичные методы отдельного класса, а не
приватные методы билдера: у хелпера может ещё не быть вызова (так вернулись `getBoolean` и
`getArray`), а `noUnusedLocals` не пропускает приватный метод без вызовов.

Форма значений передаётся контейнеру дженериком явно, без ограничения на тип, и из неё же
`Paths` и `ValueByPath` (`config-container.types.ts`) выводят допустимые пути и тип
результата `get()`. Там же `ConfigPath` и `ConfigValue` — те же типы, применённые к
`ConfigValues` (их берёт `shared/config-value.ts`), алиас `CC` (зависимость от контейнера
везде называется `cc` и типизируется им) и `RawConfig`: снимок лежит в общем файле, а не у
storage или builder, потому что работают с ним оба, а друг о друге они не знают.

Форма конфигурации целиком — `config-values.ts`: `ConfigValues` и типы, объявленные для
самого конфига (`Environment`, `LoggerConfig`, `TelegramLimits`). `ConfigStorage` и
`ConfigEnvStorage` (`storage/`) не импортируют ни одного модуля, кроме `dotenv`: это механика
источника, и следующий источник ляжет рядом с ними. `ConfigValues` импортирует типы настроек всех сторон
(их список — импорты файла), поэтому каталог принадлежит корню сборки. Своих копий этих типов
в конфиге нет намеренно: форма настроек объявлена там, где её потребляют, дубль пришлось бы
править дважды, а рассинхрон по необязательному полю не поймали бы ни компилятор, ни тесты.

Исключение одно — `TelegramLimits`: он объявлен в `config-values.ts`, и потребитель
`telegram/telegram-limit-resolver.ts` импортирует его из корня сборки, то есть стрелка идёт
обратно.

| Переменная | Назначение (по умолчанию) |
|---|---|
| `NODE_ENV` | режим приложения (`development`); от него зависят адаптер логгера и порог ([`logging.md`](./logging.md)) |
| `BOT_TOKEN` | токен бота, обязателен: пустой валит сборку конфига, конструктор `Bot` проверяет его ещё раз |
| `TEMP_DIR` | временные файлы конвертации (`<root>/tmp`) |
| `FONT_FORGE_PATH` | бинарник FontForge (`fontforge`) |
| `LIMIT_{COMMON,PRIVATE,GROUP}_{NUMBER,INTERVAL}` | лимиты очереди, интервалы в мс, оба от 1 ([инвариант](./invariants.md)); значения по умолчанию — [`outbound-queue.md`](./outbound-queue.md) |
| `RUNNER_SLEEP_INTERVAL_MIN` / `RUNNER_SLEEP_INTERVAL_MAX` | границы случайного сна Runner, мс; значения по умолчанию — [`outbound-queue.md`](./outbound-queue.md); от 1 до 2147483647, максимум не меньше минимума |
| `RUNNER_MAX_RETRIES` | повторов задачи до отбрасывания (3), от 0 |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | общий срок остановки (15000), до 2147483647 и больше суммы двух ниже ([инвариант](./invariants.md)) |
| `BOT_GRACEFUL_SHUTDOWN_TIMEOUT` | остановка runner'а бота (3000), от 0 до 2147483647 |
| `TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT` | разгрузка очереди (5000), от 0 до 2147483647, `0` — не ждать |
| `TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL` | шаг опроса очереди (500), от 1 до 2147483647 |
| `TASK_QUEUE_LOG_INTERVAL` | период info-лога `TaskQueue`: число задач и партиций, а во время паузы после 429 — её остаток (10000), от 1 до 2147483647 |
| `LOGGER_LEVEL` | порог логирования |
| `DATABASE_HOST/PORT/NAME/USER_NAME/USER_PASSWORD` | подключение, порт от 1 до 65535; внутри compose host/port задаёт `docker-compose.app.yml` |
| `DATABASE_CONNECTION_LIMIT/IDLE_TIMEOUT/MAX_LIFETIME` | пул (10, 10 с, 600 с); лимит от 1, сроки от 0 до 2147483 с: `postgres.js` умножает их на 1000 для таймера, а `0` у него выключает таймер |

`DATABASE_SUPERUSER_PASSWORD`, `DATABASE_TIMEZONE`, `DATABASE_DATE_STYLE` читает только
`docker-compose.db.yml`; `DATABASE_SUPERUSER_NAME`, `DATABASE_USER_NAME`,
`DATABASE_USER_PASSWORD` и `DATABASE_NAME` читает ещё и скрипт первичной инициализации
`docker/pgsql/docker-entrypoint-initdb.d/init-user-db.sh`. Скрипт отрабатывает только на
пустом каталоге данных: переименование любой из них ломает не текущую базу, а следующую.
Исключение из «только» — хук тестов `test/database-hook.ts`: он создаёт базу прогона
суперпользователем (`DATABASE_SUPERUSER_NAME`, `DATABASE_SUPERUSER_PASSWORD`) из того же
окружения контейнера, и переименование ломает ещё и ближайший `make test`.
`DATABASE_URL` — только `node-pg-migrate`; собирается в `docker-compose.app.yml`, потому
что в `.env` подстановки `${...}` нет, а в `environment:` Compose она работает.

В истории git есть старый `BOT_TOKEN` в `.env.dist`; он отозван и мёртв, историю не
переписывали намеренно: после отзыва переписывание сломало бы клоны и ссылки на коммиты,
а значение всё равно осталось бы в форках и кэшах GitHub. Повторную утечку ловит secret
scanning с push protection на стороне GitHub (корневой
[`README.md`](../../README.md), «Переменные окружения»), а не хук `pre-commit`: тот
обходится `--no-verify` и на чужие клоны не действует.
