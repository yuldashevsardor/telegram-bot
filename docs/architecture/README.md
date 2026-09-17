# Архитектура

Каталог описывает код таким, какой он есть, включая известные проблемы: они помечены
по месту ссылкой на issue. Найдя новую проблему, опишите её в файле подсистемы и
заведите issue; сводного списка проблем в каталоге нет намеренно, он в трекере.

Рантайм-последовательности стоят в файлах своих подсистем: старт и остановка —
[`application.md`](./application.md), входящий апдейт и команды — [`bot.md`](./bot.md),
исходящий вызов — [`outbound-queue.md`](./outbound-queue.md), загрузка локалей —
[`i18n.md`](./i18n.md).

## Оглавление

- [`application.md`](./application.md) — контейнер inversify, `ApplicationContext`, старт
  и остановка процесса
- [`bot.md`](./bot.md) — пайплайн апдейта, фильтры, middleware, очередь исходящих на
  `ctx.api`, команды
- [`outbound-queue.md`](./outbound-queue.md) — лимиты, партиции, цикл `Runner`, путь
  исходящего вызова
- [`font-convertor.md`](./font-convertor.md) — пары форматов, EOT-кодек, сигнатуры,
  запуск движка
- [`user.md`](./user.md) — сущность, репозиторий, наполнение контекста
- [`logging.md`](./logging.md) — порт и адаптеры, пороги, корреляция запроса
- [`i18n.md`](./i18n.md) — локали, бандлы Fluent, описания команд
- [`storage.md`](./storage.md) — `Database`, миграции, заготовка миграции, когда у
  хранилища заводится свой интерфейс
- [`config.md`](./config.md) — `ConfigContainer` и таблица переменных окружения
- [`testing.md`](./testing.md) — `mocha`, линтеры, покрытие, гейты, мутационное тестирование
- [`invariants.md`](./invariants.md) — правила, которые компилятор не связывает:
  нарушение компилируется и ломает поведение молча

## Обзор

Назначение — конвертация шрифтов между форматами (`src/font-convertor/`,
[`font-convertor.md`](./font-convertor.md); предметная область —
[`CONTEXT.md`](../../CONTEXT.md)). Telegram — способ доставки; `User`, сессии и миграции
существуют ради Telegram-фронтенда.

Стек:

- **grammY** + `@grammyjs/runner` (long polling, конкурентная обработка апдейтов)
  + `@grammyjs/conversations`.
- **inversify** — DI, биндинги вручную.
- **PostgreSQL** — клиент `postgres` (porsager) в рантайме, `node-pg-migrate` для миграций.
- **pino** в production, `console` в остальных режимах — за интерфейсом `Logger`.
- **FontForge** — внешний CLI.
- **Fluent** (`@moebius/fluent`) — i18n, локали `ru` (дефолтная) и `en`. Плагин
  `@grammyjs/fluent` не используется: контекст наполняет свой middleware
  ([`i18n.md`](./i18n.md)).

Раскладка `src/` — по назначению, а не по техническим слоям (план перестройки —
[#245](https://github.com/yuldashevsardor/telegram-bot/issues/245)). Модулей два:
`font-convertor/` — единственный предметный, и `telegram/`, где собрано то, что существует
ради Telegram (выше), — бот, `User` и очередь исходящих. Вокруг них три каталога по роли:
`platform/` — адаптеры к внешнему миру, которые не импортируют ни одного модуля;
`bootstrap/` — корень сборки, он знает все стороны разом, и в этом его работа; `shared/` —
то, что берут все: базовая ошибка, сквозные типы, словарь токенов DI, `configValue` и
утилиты.

Отдельного слоя между интерфейсом и реализацией нет, сколько бы реализаций ни было:
интерфейс `Logger` и оба адаптера лежат в `platform/logger/`, `UserRepository` и
`PgSqlUserRepository` — в `telegram/user/` ([`storage.md`](./storage.md)). По каталогам
такая пара всё равно может разойтись, но уже не по слоям: `LimitResolver` объявлен в `telegram/outbound-queue/`, где
его зовут, а `TelegramLimitResolver` лежит выше, в `telegram/`, потому что выбор лимита по
chat ID — знание о Telegram, а не об очереди
([`outbound-queue.md`](./outbound-queue.md)).

Ошибки: наружу уходит только `RuntimeError` (`shared/errors.ts`) или его подкласс из
`<модуль>.errors.ts` рядом с бросающим кодом (`<модуль>` — префикс имени файла, а не
каталог); единственный подкласс вне `*.errors.ts` — `InvalidConfigError`, он лежит рядом
с базовым. Ошибка, которая описывает контракт, а не дело одного файла, может лежать у
контракта, а не рядом с бросающим кодом: `InvalidLogLevel` (недопустимый `Level`) — в
`platform/logger/logger.errors.ts`, а бросает её `AbstractLogger`; `UpdateWithoutFrom` — в
`telegram/bot.errors.ts`, а бросает `fill-user-to-context.middleware.ts`. Конструктор —
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
требование к такой команде — не уехать в прод. Тестов послабление не касается: пока команда
есть, её спека держит поведение как есть, вместе с этой привязкой
([`testing.md`](./testing.md), «Мутационное тестирование»). Запрет на прямой `console.*`
([`logging.md`](./logging.md)) под послабление не попадает: он держится линтером на весь
репозиторий.

## Карта директорий

```
src/
  app.ts                    точка входа: new Application(), сигналы, fail()
  font-convertor/           конвертация шрифтов (font-convertor.md)
    font-signature-matcher/ FontSignatureMatcher и его типы
  telegram/                 grammY: команды, conversations, middleware, фильтры, сессия, локали (bot.md, i18n.md)
    user/                   сущность, интерфейс репозитория, сервис, адаптер к PostgreSQL (user.md)
    outbound-queue/         очередь исходящих по ключам, лимиты, цикл Runner (outbound-queue.md)
  platform/                 адаптеры, не знающие модулей
    database/               Database (storage.md)
    logger/                 интерфейс Logger, enum Level, ConsoleLogger, PinoLogger (logging.md)
    request-context/        RequestContext: область и значения запроса (logging.md)
  bootstrap/                корень сборки, знает все стороны
    application/            ApplicationContext и Application: сборка и жизненный цикл (application.md)
    container/              inversify-контейнер (application.md)
    config/                 ConfigContainer, форма ConfigValues, типы путей get() и алиас CC (config.md)
      builder/              интерфейс ConfigBuilder и ConfigValuesBuilder: сборка и валидация ConfigValues (config.md)
      parser/               ConfigParser: строгий разбор строк снимка источника (config.md)
      storage/              ConfigStorage и ConfigEnvStorage — источник значений (config.md)
  shared/                   RuntimeError, сквозные типы, словарь токенов DI, configValue (application.md);
                            NumberHelper, utils (sleep, withTimeout)
    fs/                     FileHelper
    process/                ProcessHelper — запуск внешних процессов (invariants.md)
    string/                 StringHelper
test/                       mocha-спеки; путь спеки повторяет путь исходника, кроме каталога
                            вокруг одного главного файла (правило ниже);
                            общий код спек — *.helper.ts рядом со спекой своего исходника, а у
                            корневого хука — рядом с ним;
                            coverage-hook.ts — хук make coverage, database-hook.ts — база на прогон,
                            database.helper.ts — её имя для спек,
                            stryker-mocha-hook.cjs — шим mocha 12 для make mutation (testing.md)
migrations/                 миграции, в common/ — общие shorthands и заготовка (storage.md)
scripts/                    хостовые скрипты целей make; claude-worktree-guard — хук (testing.md)
```

Подсистема — каталог, который карта выше называет вместе с его файлом в
`docs/architecture/`, и каталог роли: `platform/`, `bootstrap/`, `shared/` и роли внутри
них (`fs/`, `process/`, `string/`, `builder/`, `parser/`, `storage/`). Каталог внутри
подсистемы (у `shared/` правило своё, оно ниже) заводится хотя бы по одному из трёх
оснований — прячет, собирает, держит главный со спутниками, — иначе не заводится.
Первые два — заявление о границе видимости: каталог, из которого импортируют всё подряд,
границы не объявляет, а только удлиняет путь импорта. Третье о видимости не заявляет (из
`shared/fs/` снаружи импортируют и `file-helper.ts`, и `file-helper.errors.ts`) и стоит в
правиле затем, чтобы место спутника не зависело от того, в какой половине дерева лежит
главный: в `shared/` спутники уезжали в каталог всегда. Из каталогов внутри подсистемы
карта называет один — `font-signature-matcher/`, как пример правила; `convertor/`,
`eot-packer/`, `font-forge/` и остальные стоят в примерах ниже.

**Прячет** — снаружи него импортируется ровно один его файл, остальные файлы каталога его
внутренности: `eot-packer/eot-packer.ts`, `font-forge/font-forge.ts`,
`convertor/convertor-factory.ts`. Имя каталога — префикс имени этого файла, чтобы путь
импорта угадывался по имени класса.

**Собирает** — однотипных братьев одного контракта, которых перечисляет один регистратор:
`convertor/<from>/` перечисляет `convertor-factory.ts`, `command/`, `filter/` и
`middleware/` — `container.ts`, `locale/` — обход каталога в `createFluent()`
(`locale.ts`). Базовый класс контракта лежит при братьях (`command/command.ts`,
`filter/filter.ts`, `middleware/middleware.ts`) или в родителе (`convertor/convertor.ts`).

**Держит главный со спутниками** — `*.types.ts` и `*.errors.ts` лежат в каталоге вместе со
своим главным, а имя каталога — префикс имени главного:
`font-signature-matcher/font-signature-matcher.ts` со своим `*.types.ts`,
`eot-packer/eot-packer.ts` со своим `*.errors.ts`. Так же лежат спутники и в каталогах,
которые карта называет сама: `font-convertor/font-convertor.*`, `platform/logger/logger.*`,
`telegram/user/user.*` — имя каталога и там префикс имени главного.

Дерево под это основание переведено не целиком: главные файлы, чьи спутники лежат в
каталоге с другим именем, ещё есть — их печатает команда (`shared/` из вывода вычтен, там
имя каталога своё):

```bash
find src -name '*.types.ts' -o -name '*.errors.ts' | while read -r f; do m="${f%.*.ts}"; \
    [ -f "$m.ts" ] && [ "$(basename "$(dirname "$f")")" != "$(basename "$m")" ] \
    && echo "$m.ts"; done | grep -v '^src/shared/' | sort -u
```

Вывод — не готовый список правок: двум файлам из него правило даёт больше одного ответа.
`src/telegram/locale.ts` регистрирует братьев из каталога `locale/` рядом с собой, и его
собственный каталог встал бы над ними; `src/font-convertor/eot-packer/sfnt-reader.ts` —
внутренность прячущего каталога, и его каталог встал бы внутри `eot-packer/`.

Иначе файлы лежат плоско: части подсистемы группирует префикс имени файла, а файл без
спутников каталога не заводит (`font-convertor/sfnt-version.ts` — набор версий sfnt, общий
на два модуля подсистемы). Двум каталогам оснований не хватает: в `telegram/session/` лежат
три файла разных ролей (`pgsql-storage.ts`, `session.helper.ts`, `session.types.ts`), и ни
один не прячет остальных; в `telegram/middleware/mutation/` файл один, и его же импортируют
снаружи — прятать нечего, каталог держит роль.

В `shared/` от правила остаётся одно намеренное расхождение — имя каталога: он назван по
роли (`fs/`, `process/`, `string/`), а не префиксом главного файла. Утилита из одного файла
лежит плоско в корне (`number-helper.ts`, `utils.ts`); корневые `errors.ts` и `types.ts` —
самостоятельные файлы, а не спутники, и в каталог никого не уводят.

Какие файлы каталога видны снаружи, считает команда (`<путь>` — от `src/`; для `locale/`
неприменима, `.ftl` через алиас не импортируют):

```bash
grep -rHoE "app/<путь>/[A-Za-z0-9._-]+" src --include='*.ts' | grep -v "^src/<путь>/" \
    | sed "s#.*app/<путь>/##" | sort -u
```

Путь спеки повторяет путь исходника, кроме одного: каталог внутри подсистемы, названный
префиксом имени своего главного файла, в пути спеки не отражается — файлы `convertor/`,
`eot-packer/`, `font-forge/` и `font-signature-matcher/` проверяют спеки прямо из
`test/font-convertor/`. Каталог самой подсистемы и каталог роли отражаются, даже когда
устроены так же: `platform/request-context/` держит главный со спутником, а спека лежит в
`test/platform/request-context/`; так же `bootstrap/config/parser/` и `shared/fs/`.
Каталог братьев и каталог брата — исключение из этого правила, отражаются оба: и брат,
названный префиксом (`telegram/command/start/`), и брат, названный по роли
(`telegram/middleware/mutation/`); каталог братьев внутри неотражаемого отразится без
него: спека `convertor/eot/eot-to-ttf.ts` встала бы в `test/font-convertor/eot/` (спек у
пар сейчас нет). Расхождения печатает команда, и в её выводе — только спеки каталогов с
префиксным именем:

```bash
find test -name '*.spec.ts' | while read -r s; do base=$(basename "$s" .spec.ts); \
    srcs=$(find src -name "$base.ts"); [ -z "$srcs" ] && continue; \
    echo "$srcs" | grep -q "^src$(dirname "$s" | sed 's#^test##')/$base\.ts$" \
    || echo "$s | $(echo "$srcs" | tr '\n' ' ')"; done
```

Импорты только через алиас `app/*` (`tsconfig.json` + `tsc-alias`), относительные
запрещены ESLint-правилом `no-restricted-imports`. Спеки импортируют общий код из `test/`
вторым алиасом, `test/*`: он объявлен только в `tsconfig.check.json`, и в сборке его нет
(почему и чем это грозит — комментарий там же). Исключение — каталог `migrations/`:
он лежит вне `src/`, алиас туда не ведёт, и правило снято на весь каталог через
`overrides` в `.eslintrc.js`.

Независимость домена (`CLAUDE.md`, «Стиль») линтер не проверяет. `font-convertor/` не
импортирует ни `platform/`, ни `bootstrap/` напрямую, но независимость не полная:
`shared/config-value.ts` берёт конфигурацию у `ApplicationContext`
([`application.md`](./application.md)), то есть рантайм-зависимость от корня сборки в
`shared/` одна и домен дотягивается через неё до `pino`.
