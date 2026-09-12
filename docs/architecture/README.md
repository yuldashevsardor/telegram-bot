# Архитектура

Каталог описывает код таким, какой он есть, включая известные проблемы: они помечены
по месту ссылкой на issue. Найдя новую проблему, опишите её в файле подсистемы и
заведите issue; сводного списка проблем в каталоге нет намеренно, он в трекере.

Рантайм-последовательности стоят в файлах своих подсистем: старт и остановка —
[`application.md`](./application.md), входящий апдейт и команды — [`bot.md`](./bot.md),
исходящий вызов — [`task-queue.md`](./task-queue.md), загрузка локалей —
[`i18n.md`](./i18n.md).

## Оглавление

- [`application.md`](./application.md) — контейнер inversify, `ApplicationContext`, старт
  и остановка процесса
- [`bot.md`](./bot.md) — пайплайн апдейта, фильтры, middleware, очередь исходящих на
  `ctx.api`, команды
- [`task-queue.md`](./task-queue.md) — лимиты, партиции, цикл `Runner`, путь исходящего
  вызова
- [`font-convertor.md`](./font-convertor.md) — пары форматов, EOT-кодек, сигнатуры,
  запуск движка
- [`user.md`](./user.md) — сущность, репозиторий, наполнение контекста
- [`logging.md`](./logging.md) — порт и адаптеры, пороги, корреляция запроса
- [`i18n.md`](./i18n.md) — локали, бандлы Fluent, описания команд
- [`storage.md`](./storage.md) — `Database`, миграции, заготовка миграции, выбор между
  портом в домене и адаптером рядом с потребителем
- [`config.md`](./config.md) — `ConfigContainer` и таблица переменных окружения
- [`testing.md`](./testing.md) — `mocha`, линтеры, покрытие, гейты
- [`invariants.md`](./invariants.md) — правила, которые компилятор не связывает:
  нарушение компилируется и ломает поведение молча

## Обзор

Назначение — конвертация шрифтов между форматами (`src/domain/font-convertor/`,
[`font-convertor.md`](./font-convertor.md); предметная область —
[`CONTEXT.md`](../../CONTEXT.md)). Telegram — способ доставки; `User`, сессии и миграции
существуют ради Telegram-фронтенда.

Стек:

- **grammY** + `@grammyjs/runner` (long polling, конкурентная обработка апдейтов)
  + `@grammyjs/conversations`.
- **inversify** — DI, биндинги вручную.
- **PostgreSQL** — клиент `postgres` (porsager) в рантайме, `node-pg-migrate` для миграций.
- **pino** в production, `console` в остальных режимах — за доменным интерфейсом `Logger`.
- **FontForge** — внешний CLI.
- **Fluent** (`@moebius/fluent`) — i18n, локали `ru` (дефолтная) и `en`. Плагин
  `@grammyjs/fluent` не используется: контекст наполняет свой middleware
  ([`i18n.md`](./i18n.md)).

Слои: `domain/` — логика и порты, `infrastructure/` — адаптеры, `common/` — сквозные
типы, базовая ошибка и словарь токенов DI, `helper/` — утилиты. Разделение
последовательно у `user` и `logger`; `task-queue` порта почти не имеет, потому что
внешней системы за ним нет.

Ошибки: наружу уходит только `RuntimeError` (`common/errors.ts`) или его подкласс из
`<модуль>.errors.ts` рядом с бросающим кодом (`<модуль>` — префикс имени файла, а не
каталог); единственный подкласс вне такого файла — `InvalidConfigError`, он лежит рядом
с базовым. Конструктор —
`new RuntimeError(message, payloadOrCause)`: `Error` вторым аргументом уходит в
стандартный `cause`, объект — в `payload`. `Error` в поле `cause` такого объекта
переезжает в стандартный `cause` и в `payload` не остаётся: иначе сериализатор логов
развернул бы одну и ту же ошибку дважды — по `payload.cause` и по `cause`. Детали
собирают статические фабрики по месту (`ExtensionNotSupport.byExtension()`). Чужую
ошибку без своих деталей оборачивает `byError()` — он берёт её message и кладёт её саму
в `cause`; если нужен ещё и payload, ошибка передаётся полем `cause` внутри него
(`UserService.create()`).

Команды бота: `/start` — conversation с приветствием; `/font_generator` — отладочная
конвертация фиксированного файла ([`font-convertor.md`](./font-convertor.md));
`/bulk_messages` — нагрузочный инструмент, а не фича.

`/font_generator` и `/bulk_messages` — тестовые команды: они нужны только в разработке и
до выкладки в прод снимаются. Продовые мерки к ним не применяются — привязка к среде
разработчика (входной шрифт из тестовой фикстуры, захардкоженные chat ID и путь машины
автора), отсутствие проверки прав, `container.get()` вместо внедрения зависимостей
считаются свойством тестовой команды, а не дефектом, и чинить их не нужно. Единственное
требование к такой команде — не уехать в прод. Запрет на прямой `console.*`
([`logging.md`](./logging.md)) под послабление не попадает: он держится линтером на весь
репозиторий.

## Карта директорий

```
src/
  app.ts                    точка входа: new Application(), сигналы, fail()
  common/                   RuntimeError, сквозные типы, словарь токенов DI, configValue (application.md)
  domain/
    task-queue/             очередь исходящих по ключам, лимиты, цикл Runner (task-queue.md)
    font-convertor/         конвертация шрифтов (font-convertor.md)
    user/                   сущность, порт репозитория, сервис (user.md)
    logger/                 интерфейс Logger, enum Level (logging.md)
  helper/                   string/number/file/process/utils (sleep, withTimeout)
  infrastructure/
    application/            ApplicationContext и Application: сборка и жизненный цикл (application.md)
    bot/                    grammY: команды, conversations, middleware, фильтры, сессия (bot.md)
    config/                 ConfigStorage → ConfigContainer (config.md)
    container/              inversify-контейнер (application.md)
    database/               Database (storage.md)
    logger/                 ConsoleLogger, PinoLogger (logging.md)
    repository/             PgSqlUserRepository (user.md)
    request-context.ts      RequestContext: область и значения запроса (logging.md)
    request-context.types.ts  ключи и тип значений запроса (logging.md)
test/                       mocha-спеки, зеркалят src/
migrations/                 миграции, в common/ — общие shorthands и заготовка (storage.md)
scripts/                    хостовые скрипты целей make; claude-worktree-guard — хук (testing.md)
```

Импорты только через алиас `app/*` (`tsconfig.json` + `tsc-alias`), относительные
запрещены ESLint-правилом `no-restricted-imports`. Исключение — каталог `migrations/`:
он лежит вне `src/`, алиас туда не ведёт, и правило снято на весь каталог через
`overrides` в `.eslintrc.js`. Тем же правилом закреплена независимость домена
(`CLAUDE.md`, «Стиль»), и в его блоке запрет относительных перечислен заново: `overrides`
заменяет конфигурацию правила целиком, а не дополняет общую.

Прямых импортов `domain → infrastructure` нет, но независимость не полная:
`common/config-value.ts` берёт конфигурацию у `ApplicationContext`
([`application.md`](./application.md)), то есть рантайм-зависимость от инфраструктуры в
`common/` одна и домен дотягивается до неё транзитивно. Линтер этого не видит — в списке
запрещённых стоят пакеты, а не свои каталоги.
