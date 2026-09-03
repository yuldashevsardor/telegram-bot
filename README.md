# telegram-bot

Telegram-бот для конвертации файлов шрифтов между форматами (`ttf`, `otf`, `woff`, `woff2`, `eot`, `svg`).
Конвертация выполняется через FontForge, состояние пользователей и сессий хранится в PostgreSQL.

Архитектура и рантайм-трассировки описаны в [`docs/architecture.md`](docs/architecture.md) и [`docs/flows.md`](docs/flows.md).

## Быстрый старт

Из требований на машине нужен только Docker (с плагином Compose v2). Node и FontForge
устанавливать не нужно — они входят в образ приложения.

```bash
cp .env.dist .env
# впишите в .env токен от @BotFather
docker compose up --build
```

Поднимаются два сервиса:

| Сервис  | Что делает                                                                                  |
| ------- | ------------------------------------------------------------------------------------------- |
| `pgsql` | PostgreSQL 18; при первой инициализации создаёт роль и базу приложения                        |
| `app`   | накатывает миграции, затем запускает бота; стартует, только когда `pgsql` прошёл healthcheck   |

Среда только для разработки: `./src` смонтирован с хоста, приложение работает через
`npm run dev` (`node --watch` + `ts-node`) и перезапускается на правку исходников.
Production-конфигурации в репозитории нет — как сервис разворачивается на сервере,
здесь не описано.

`node --watch` следит за конкретными файлами по inode, поэтому операции, подменяющие файл целиком
(`git checkout`, атомарное сохранение в некоторых редакторах), могут «отвязать» наблюдателя от
файла. Если перезапуски перестали происходить — `docker compose restart app`.

Остановить всё: `docker compose down`. Данные БД лежат в `./tmp/pgsql` (каталог `tmp/`
целиком в `.gitignore`); чтобы начать с чистой базы — `docker compose down && rm -rf tmp/pgsql`.

## Параллельная работа в нескольких worktree

Каждая задача ведётся в своём рабочем дереве, но полный стек поднимается только из основного:
имя compose-проекта зашито в `docker-compose.yml`, а данные БД лежат в `./tmp/pgsql`. Дерево
задачи поднимает один сервис `app` и ходит в общую базу основного дерева.

Токенов у проекта несколько — по одному на одновременно запущенного бота: два процесса на
long polling с одним токеном получают от Telegram 409 Conflict и растаскивают апдейты друг
у друга. Пул лежит вне репозитория, по одному токену на строку:

```bash
mkdir -p ~/.config/telegram-bot
$EDITOR ~/.config/telegram-bot/tokens   # по токену от @BotFather на строку
chmod 600 ~/.config/telegram-bot/tokens
```

Дальше в рабочем дереве задачи:

```bash
cp /путь/к/основному/дереву/.env .env
scripts/bot-token.sh acquire            # занять слот и записать BOT_TOKEN в .env

cat >> .env <<'EOF'
COMPOSE_PROJECT_NAME=tg-моя-ветка
APP_DATABASE_HOST=host.docker.internal
APP_DATABASE_PORT=54320
EOF

docker compose up --build --no-deps app
```

`APP_DATABASE_PORT` — это `DATABASE_PORT`, проброшенный на хост основным деревом; `--no-deps`
не даёт поднять второй `pgsql`.

Аренда токена закреплена за путём рабочего дерева и протухает через `BOT_TOKEN_TTL`
(по умолчанию 2 часа):

```bash
scripts/bot-token.sh renew     # продлить перед запуском бота и перед долгой работой
scripts/bot-token.sh status    # какие слоты кем заняты
scripts/bot-token.sh release   # освободить слот, закончив работу
```

Удалённое или брошенное дерево освобождает слот само — по исчезнувшему пути или по TTL,
отдельная уборка не нужна.

## Полезные команды

Всё выполняется внутри контейнера — на хосте ни Node, ни зависимостей нет.

```bash
docker compose logs -f app                          # логи бота
docker compose exec app npm run migrate -- up       # накатить миграции повторно
docker compose exec app npm run build               # проверка типов и сборка
docker compose exec app npm test
docker compose exec app sh                          # шелл внутри контейнера приложения
docker compose exec pgsql psql -U root -d docker_db
```

Создать новую миграцию:

```bash
docker compose exec app npm run migrate -- create my-migration-name
```

Файл появится в `src/infrastructure/database/migrations/` — каталог `src` смонтирован с хоста,
так что новая миграция сразу окажется в репозитории.

## Переменные окружения

Все переменные живут в `.env` (шаблон — `.env.dist`) и передаются в контейнеры через `env_file`.
Обязательно задать только `BOT_TOKEN`.

Адрес БД внутри compose-сети — всегда `pgsql:5432`, он задан в `docker-compose.yml`
(блок `environment` приоритетнее `env_file`). Значения `DATABASE_HOST`/`DATABASE_PORT`
из `.env` описывают подключение **снаружи** контейнеров: `DATABASE_PORT` — это порт,
на который Postgres пробрасывается на хост (`ports: ${DATABASE_PORT}:5432`), им же
пользуются `psql`, DBeaver и прочие клиенты на хосте.

`DATABASE_URL` читает только `node-pg-migrate`; она собирается в `docker-compose.yml`
и в `.env` не хранится. Само приложение собирает подключение из отдельных полей
host/port/user/password.
