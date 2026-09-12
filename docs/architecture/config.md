# Конфигурация

`ConfigStorage` (`get(key)`) → `ConfigEnvStorage` (`dotenv` в конструкторе, читает
`process.env`) → `ConfigContainer` разбирает и валидирует всё сразу и раздаёт готовые
значения и секции. Раскрытия `${...}` в `.env` нет. Тесты подкладывают
фейковый сторедж.

Цепочка разрезана по каталогам. `ConfigStorage` и `ConfigEnvStorage` (`platform/config/`)
не импортируют ни одного модуля: это механика источника, и следующий источник ляжет рядом
с ними. `ConfigContainer` (`bootstrap/config-container.ts`) импортирует типы настроек
всех сторон (их список — импорты файла) и потому принадлежит корню сборки. Своих копий этих типов в конфиге нет намеренно: форма настроек
объявлена там, где её потребляют, дубль пришлось бы править дважды, а рассинхрон по
необязательному полю не поймали бы ни компилятор, ни тесты.

| Переменная | Назначение (по умолчанию) |
|---|---|
| `NODE_ENV` | режим приложения (`development`); от него зависят адаптер логгера и порог ([`logging.md`](./logging.md)) |
| `BOT_TOKEN` | токен бота; пустой валит конструктор `Bot`, а не сборку конфига |
| `TEMP_DIR` | временные файлы конвертации (`<root>/tmp`) |
| `FONT_FORGE_PATH` | бинарник FontForge (`fontforge`) |
| `LIMIT_{COMMON,PRIVATE,GROUP}_{NUMBER,INTERVAL}` | лимиты очереди, интервалы в мс; значения по умолчанию — [`outbound-queue.md`](./outbound-queue.md) |
| `RUNNER_SLEEP_INTERVAL_MIN` / `RUNNER_SLEEP_INTERVAL_MAX` | границы случайного сна Runner, мс; значения по умолчанию — [`outbound-queue.md`](./outbound-queue.md); минимум больше нуля, максимум не меньше минимума |
| `RUNNER_MAX_RETRIES` | повторов задачи до отбрасывания (3) |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | общий срок остановки (15000), больше суммы двух ниже ([инвариант](./invariants.md)) |
| `BOT_GRACEFUL_SHUTDOWN_TIMEOUT` | остановка runner'а бота (3000) |
| `TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT` | разгрузка очереди (5000), `0` — не ждать |
| `TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL` | шаг опроса очереди (500), больше нуля |
| `LOGGER_LEVEL` | порог логирования |
| `DATABASE_HOST/PORT/NAME/USER_NAME/USER_PASSWORD` | подключение; внутри compose host/port задаёт `docker-compose.app.yml` |
| `DATABASE_CONNECTION_LIMIT/IDLE_TIMEOUT/MAX_LIFETIME` | пул (10, 10 с, 600 с) |

`DATABASE_SUPERUSER_PASSWORD`, `DATABASE_TIMEZONE`, `DATABASE_DATE_STYLE` читает только
`docker-compose.db.yml`; `DATABASE_SUPERUSER_NAME`, `DATABASE_USER_NAME`,
`DATABASE_USER_PASSWORD` и `DATABASE_NAME` читает ещё и скрипт первичной инициализации
`docker/pgsql/docker-entrypoint-initdb.d/init-user-db.sh`. Скрипт отрабатывает только на
пустом каталоге данных: переименование любой из них ломает не текущую базу, а следующую.
`DATABASE_URL` — только `node-pg-migrate`; собирается в `docker-compose.app.yml`, потому
что в `.env` подстановки `${...}` нет, а в `environment:` Compose она работает.

В истории git есть старый `BOT_TOKEN` в `.env.dist`; он отозван и мёртв, историю не
переписывали намеренно: после отзыва переписывание сломало бы клоны и ссылки на коммиты,
а значение всё равно осталось бы в форках и кэшах GitHub. Повторную утечку ловит secret
scanning с push protection на стороне GitHub (корневой
[`README.md`](../../README.md), «Переменные окружения»), а не хук `pre-commit`: тот
обходится `--no-verify` и на чужие клоны не действует.
