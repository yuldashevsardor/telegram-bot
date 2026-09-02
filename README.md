# telegram-bot

Telegram-бот для конвертации файлов шрифтов между форматами (`ttf`, `otf`, `woff`, `woff2`, `eot`, `svg`).
Конвертация выполняется через FontForge, состояние пользователей и сессий хранится в PostgreSQL.

Архитектура и рантайм-трассировки описаны в [`docs/architecture.md`](docs/architecture.md) и [`docs/flows.md`](docs/flows.md).

## Быстрый старт

Из требований на машине нужен только Docker (с плагином Compose v2). Node, Python и FontForge
устанавливать не нужно — они входят в образ приложения.

```bash
cp .env.dist .env
# впишите в .env токен от @BotFather
docker compose up --build
```

Эта команда поднимает три сервиса:

| Сервис    | Что делает                                                                              |
| --------- | --------------------------------------------------------------------------------------- |
| `pgsql`   | PostgreSQL 18; при первой инициализации создаёт роль и базу приложения                    |
| `migrate` | одноразовый прогон `node-pg-migrate up`; стартует, только когда `pgsql` прошёл healthcheck |
| `app`     | сам бот; стартует, только когда `migrate` завершился успешно                               |

Остановить всё: `docker compose down`. Удалить и данные БД: `docker compose down -v`.

## Режимы запуска

`docker-compose.override.yml` подхватывается автоматически, поэтому обычный `docker compose up`
даёт **dev-режим**: собирается стадия `development`, `./src` смонтирован с хоста, приложение
запускается через `npm run dev` (`node --watch` + `ts-node`) и перезапускается на изменения.

`node --watch` следит за конкретными файлами по inode, поэтому операции, подменяющие файл целиком
(`git checkout`, атомарное сохранение в некоторых редакторах), могут «отвязать» наблюдателя от
файла. Если перезапуски перестали происходить — `docker compose restart app`.

**Production-режим** — запуск без override-файла:

```bash
docker compose -f docker-compose.yml up --build -d
```

Здесь собирается стадия `production`: слим-образ с прод-зависимостями, скомпилированным `build/`
и `ENVIRONMENT=production` (то есть `PinoLogger` вместо `ConsoleLogger`).

## Полезные команды

```bash
docker compose logs -f app                  # логи бота
docker compose run --rm migrate             # применить миграции повторно
docker compose exec app sh                  # шелл внутри контейнера приложения
docker compose exec pgsql psql -U root -d docker_db
```

Создать новую миграцию (нужен dev-образ, поэтому через сервис `migrate`):

```bash
docker compose run --rm --entrypoint sh migrate -c 'npm run migrate -- create my-migration-name'
```

Файл появится в `src/infrastructure/database/migrations/` — при работе через `docker compose up`
каталог `src` смонтирован с хоста, так что новый файл сразу окажется в репозитории.

## Переменные окружения

Все переменные живут в `.env` (шаблон — `.env.dist`) и передаются в контейнеры через `env_file`.
Обязательно задать только `BOT_TOKEN`.

Три переменные различаются между запуском в контейнере и запуском на хосте, поэтому для
контейнеров они жёстко заданы в `docker-compose.yml` (блок `environment` имеет приоритет над
`env_file`), а в `.env` остаются host-значения:

| Переменная      | В контейнере                              | На хосте                       |
| --------------- | ----------------------------------------- | ------------------------------ |
| `DATABASE_HOST` | `pgsql` (имя compose-сервиса)              | `localhost`                    |
| `DATABASE_PORT` | `5432` (внутри compose-сети)               | `54320` (проброшенный порт)     |
| `DATABASE_URL`  | собирается из двух предыдущих               | из `.env`                      |

`DATABASE_URL` читает только `node-pg-migrate`; само приложение собирает подключение из
отдельных полей host/port/user/password.

## Запуск на хосте (без Docker)

Поддерживается, но требует ручной подготовки: Node из `.nvmrc`, установленный FontForge
(`fontforge` в `PATH`) и запущенный Postgres. Тогда:

```bash
npm ci
docker compose up -d pgsql   # если базу всё же держать в контейнере
npm run migrate -- up
npm run build && npm start   # либо npm run dev
```
