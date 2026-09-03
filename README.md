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
