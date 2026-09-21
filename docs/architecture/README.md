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
`telegram/bot/bot.errors.ts`, а бросает `fill-user-to-context.middleware.ts`;
`UserNotFound` — в `telegram/user/user.errors.ts`, у сущности, а бросает
`PgSqlUserRepository.getById()`: «пользователя нет» — словарь `User`, а не дело адаптера.
Конструктор —
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
([`testing.md`](./testing.md), "Mutation testing"). Запрет на прямой `console.*`
([`logging.md`](./logging.md)) под послабление не попадает: он держится линтером на весь
репозиторий.

## Карта директорий

```
src/
  app.ts                    точка входа: new Application(), сигналы, fail()
  font-convertor/           конвертация шрифтов (font-convertor.md)
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
      storage/              ConfigStorage и WatchableConfigStorage, страж наблюдаемости (config-storage.helper.ts), источники: env и файл (config.md)
  shared/                   RuntimeError, сквозные типы, словарь токенов DI, configValue (application.md);
                            NumberHelper, utils (sleep, withTimeout)
    fs/                     FileHelper
    process/                ProcessHelper — запуск внешних процессов (invariants.md)
    string/                 StringHelper
test/                       mocha-спеки; путь спеки повторяет путь исходника не целиком —
                            правило ниже;
                            общий код спек — *.helper.ts рядом со спекой своего исходника, а у
                            корневого хука — рядом с ним;
                            coverage-hook.ts — хук make coverage, database-hook.ts — база на прогон,
                            database.helper.ts — её имя для спек,
                            stryker-mocha-hook.cjs — шим mocha 12 для make mutation,
                            mutation-record.ts — обёртка make mutation, пишет запись прогона (testing.md)
migrations/                 миграции, в common/ — общие shorthands и заготовка (storage.md)
scripts/                    хостовые скрипты целей make; claude-worktree-guard — хук (testing.md)
```

Подсистема — каталог, названный в карте выше; `convertor/`, `eot-packer/`, `font-forge/`,
`signature-matcher/` и остальные каталоги внутри подсистем в карту не попадают. Каталог
роли — подсистема, у которой имя роль, а не имя файла внутри: `platform/`, `shared/fs/`.

Каталог внутри подсистемы (у `shared/` правило своё, оно ниже) заводится хотя бы по одному
из четырёх оснований — прячет, собирает, стоит вокруг одного брата, держит главный со
спутниками, — иначе не заводится. Границу видимости объявляет только первое: каталог, из
которого импортируют всё подряд, границы не объявляет, а только удлиняет путь импорта.
Остальным трём граница видимости не нужна — «собирает» объявляет границу контракта (из
`telegram/command/` наружу берут и базовый класс, и каждого брата), каталог со спутниками
держит их при главном, видны они снаружи или нет (из `telegram/bot/` импортируют и `bot`,
и `bot.types`, а из `signature-matcher/` — один `font-signature-matcher`), а каталог вокруг
брата отделяет от прочих братьев того, у кого есть свои файлы или своя роль.
Основание со спутниками стоит в правиле затем, чтобы место спутника не зависело от того, в
какой половине дерева лежит главный: в `shared/` спутники уезжали в каталог всегда.

**Прячет** — снаружи него импортируется ровно один его файл, остальные файлы каталога его
внутренности: `eot-packer/eot-packer.ts`, `font-forge/font-forge.ts`,
`convertor/convertor-factory.ts`. Имя каталога — префикс имени этого файла, чтобы путь
импорта угадывался по имени класса.

**Собирает** — однотипных братьев одного контракта, которых перечисляет один регистратор:
`convertor/<from>/` перечисляет `convertor-factory.ts`, `command/`, `conversation/`,
`filter/` и `middleware/` — `container.ts`, бандлы `.ftl` в каталогах `locale/` при
командах и разговорах — обход в `createFluent()` (`telegram/locale/locale.ts`). Обход ищет
файлы по расширению (`FileHelper.findFilesByExtensions()`), а не по имени каталога, поэтому
одноимённый `telegram/locale/`, где лежит сам `locale.ts` со спутниками и ни одного `.ftl`,
с каталогами бандлов не путается. Базовый класс контракта лежит при братьях
(`command/command.ts`, `conversation/conversation-handler.ts`, `filter/filter.ts`,
`middleware/middleware.ts`) или в родителе (`convertor/convertor.ts`). Имя каталога
братьев — имя их контракта (`command/` при `command.ts`) или общий признак братьев
(`convertor/eot/` — исходный формат).

**Стоит вокруг одного брата** — брат уезжает из каталога братьев в свой каталог, только
когда у него есть свои файлы или своя роль среди братьев: `command/start/`,
`command/bulk-messages/`, `command/font-generator/` и `conversation/start/` держат команду
или разговор вместе с их бандлами `locale/`, а `middleware/mutation/` — роль внутри
`middleware/`: middleware, подменяющий `ctx.api.raw` ([`bot.md`](./bot.md)), и файл в нём
пока один. Брат без того и другого лежит в каталоге братьев плоско:
`filter/has-session-key.filter.ts`, `middleware/request-log.middleware.ts`. Имя — префикс
имени файла брата (`start/` при `start.command.ts`) или роль (`mutation/`).

**Держит главный со спутниками** — `*.types.ts` и `*.errors.ts` лежат в каталоге вместе со
своим главным, а имя каталога — имя главного: `eot-packer/eot-packer.ts` со своим
`*.errors.ts`, `signature-matcher/font-signature-matcher.ts` со своим `*.types.ts` (слово
`font` вычеркнуто, абзацем ниже). Так же лежат спутники и в каталогах, которые карта
называет сама: `font-convertor/font-convertor.*`, `platform/logger/logger.*`,
`telegram/user/user.*` — имя каталога и там имя главного. Каталог со спутниками может стоять
и внутри прячущего: `eot-packer/sfnt-reader/` держит `sfnt-reader.ts` со спутниками, а
снаружи `eot-packer/` по-прежнему виден один `eot-packer.ts`.

Имя каталога не повторяет слов, которые уже сказал путь над ним: из имени, которое даёт
основание, они вычёркиваются — `bootstrap/config/container/` при `config-container.ts`,
`bootstrap/config/storage/file/` при `config-file-storage.ts`,
`telegram/user/pgsql-repository/` при `pgsql-user-repository.ts`. Файлы внутри имён не
сокращают: файл по-прежнему называется по своему классу. Каталог, чьё имя правилу
отвечает, — конечная точка своего главного: глубже тот не уезжает. Поэтому, если путь
назвал все слова, имя каталога — последнее слово имени главного, но только когда каталог,
где главный лежал бы без нового, правилу не отвечает: `convertor/` в `font-convertor/` без
последнего слова остался бы без имени, а `config-storage.ts`, заведи он спутники, останется
прямо в `storage/` — `storage/storage/`, как и `telegram/user/user/`, был бы лишним уровнем.
Имён собственных вычёркивание не режет: `font-forge/` назван по программе FontForge.

Главные файлы со спутниками, чей каталог правилу не отвечает, печатает команда: она
вычисляет по правилу имя каталога от пути над ним и сравнивает с настоящим, а затем так же
проверяет каталог уровнем выше — отвечает правилу и он, значит каталог главного лишний. Так
ловятся и главный со спутниками вне своего каталога (оставленный плоско в `telegram/`), и
слово, которое путь уже назвал, и слово, которого нет в имени главного, и лишний уровень.
Из вывода вычтены каталоги роли — любой каталог в `shared/`, имя у них своё, — и
`font-forge/`; дерево правилу отвечает целиком, и вывод пуст. Прячущие каталоги без
спутников команда не проверяет.

```bash
find src -name '*.types.ts' -o -name '*.errors.ts' | while read -r f; do m="${f%.*.ts}"; \
    [ -f "$m.ts" ] || continue; d="${f%/*}"; words="$(basename "$m" | tr '.-' '\n\n')"; \
    fit="$(for x in "$d" "${d%/*}"; do up=" $(echo "${x%/*}" | tr '/-' '  ') "; \
    want="$(echo "$words" | while read -r w; do echo "$up" | grep -q " $w " || echo "$w"; done \
    | paste -s -d - -)"; [ "$(basename "$x")" = "${want:-$(echo "$words" | tail -1)}" ] \
    && echo 1 || echo 0; done | tr -d '\n')"; [ "$fit" = 10 ] || echo "$m.ts"; done \
    | grep -vE '^src/(shared/[^/]+|font-convertor/font-forge)/' | sort -u
```

Иначе файлы лежат плоско: части подсистемы группирует префикс имени файла, а файл без
спутников каталога не заводит (`font-convertor/sfnt-version.ts`). Одному каталогу оснований
не хватает: в `telegram/session/` лежат три файла разных ролей (`pgsql-storage.ts`,
`session.helper.ts`, `session.types.ts`), ни один не прячет остальных, братьев одного
контракта среди них нет. Имя каталога совпадает с префиксом `session.helper.ts` и
`session.types.ts`, но главного со спутниками каталог не держит: `session.ts` в нём нет, и
`session.types.ts` стоит без своего главного.

В `shared/` от правила остаётся одно намеренное расхождение — имя каталога: он назван по
роли (`fs/`, `process/`, `string/`), а не именем главного файла. Утилита из одного файла
лежит плоско в корне (`number-helper.ts`, `utils.ts`); корневые `errors.ts` и `types.ts` —
самостоятельные файлы, а не спутники, и в каталог никого не уводят.

Какие файлы каталога видны снаружи, считает команда (`<путь>` — от `src/`; для каталога
бандлов `locale/` неприменима, `.ftl` через алиас не импортируют):

```bash
grep -rHoE "app/<путь>/[A-Za-z0-9._-]+" src --include='*.ts' | grep -v "^src/<путь>/" \
    | sed "s#.*app/<путь>/##" | sort -u
```

Путь спеки повторяет путь исходника, кроме одного: каталог внутри подсистемы, названный
по своему главному файлу — его именем или префиксом, в том числе с вычеркнутыми словами
пути, — в пути спеки не отражается (исключения — каталог братьев и каталог вокруг брата,
абзацем ниже): файлы `convertor/`, `eot-packer/`, `font-forge/` и `signature-matcher/`
проверяют спеки прямо из `test/font-convertor/`, `telegram/bot/bot.ts` —
`test/telegram/bot.spec.ts`, а `bootstrap/config/container/config-container.ts` —
`test/bootstrap/config/config-container.spec.ts`. Каталог самой подсистемы отражается, даже
когда устроен так же: `platform/request-context/` держит главный со спутником, а спека лежит
в `test/platform/request-context/`; так же `platform/logger/`, `platform/database/` и
`telegram/user/`, а из подкаталогов `bootstrap/config/` — `builder/`, `parser/` и
`storage/`, которые карта называет. Каталог, названный ролью, а не именем своего главного,
под правило не попадает и без оговорки: `fs/` при `file-helper.ts`, `mutation/` при
`telegram-call-api.middleware.ts`.

Каталог братьев и каталог вокруг брата из правила выпадают, но условия у них разные.
Каталог вокруг брата отражается всегда, даже когда прячет свои бандлы `locale/`:
`telegram/command/start/` (назван по `start.command.ts`) и `telegram/conversation/start/`
стоят в пути спеки полностью. Каталог братьев отражается, только когда не прячет, —
старшинство у «прячет»: `command/` (назван по `command.ts`), `conversation/`, `filter/` и
`middleware/` отдают наружу и базовый класс, и братьев и отражаются, а `convertor/` держит
каталоги братьев `<from>/`, но снаружи из него импортируют один `convertor-factory.ts`, и
в пути спеки он не отражается. Каталог братьев внутри неотражаемого отразится без него:
спека `convertor/eot/eot-to-ttf.ts` встала бы в `test/font-convertor/eot/` (спек у пар
сейчас нет).

Расхождения печатает команда — любую спеку, чей путь не повторяет путь ни одного
исходника с тем же именем. Намеренные исключения среди них — только спеки, чей путь короче
пути исходника на неотражаемые каталоги; спека глубже исходника или в другой ветке дерева
печатается так же и нарушает правило. Спеку, положенную внутрь неотражаемого каталога,
команда не покажет: путь совпадёт с путём исходника, и правило нарушится молча.

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
