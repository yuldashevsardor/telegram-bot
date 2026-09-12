# Логирование

Порт — `shared/logger.ts`, уровни `Level` и их веса `LevelSeverity` —
`logger.types.ts`, адаптеры — `platform/logger/`. Какой из них собрать, решает
`ApplicationContext` ([`application.md`](./application.md)) при старте по `isProduction`
из конфига ([`config.md`](./config.md)): в production `PinoLogger`, иначе `ConsoleLogger`.
Порог оба берут у общего `AbstractLogger`, но применяют по-разному: `ConsoleLogger`
сверяется с `isEnabled`, а `PinoLogger` перекладывает фильтрацию на pino и совпадает с ним
только потому, что кастомные уровни pino собраны из тех же `LevelSeverity`.

Порог — `LOGGER_LEVEL`: пишется он и всё серьёзнее; по умолчанию `WARNING` в production,
`DEBUG` иначе. Неизвестное значение — `InvalidConfigError`.

Корреляция запросов: `RequestContextMiddleware` (первый из middleware,
[`bot.md`](./bot.md)) выполняет остаток пайплайна в `requestContext.run(next)`.
`AbstractLogger` принимает `RequestContext` зависимостью конструктора и в момент записи
забирает у него `getValues()` — `PinoLogger` кладёт значения полями объекта рядом с
`message` и `payload`, `ConsoleLogger` печатает чипами `[key=value]` перед сообщением.
Логгер при этом один на процесс и не подменяется, а забор значений живёт в общем
`AbstractLogger`, поэтому корреляция работает на обоих адаптерах, в том числе в
разработке.

Область `run()` — это цепочка middleware, и только она, поэтому всё, что пишется вне её,
идёт без `requestId`. Так уходит отброс в базовом `Filter` ([`bot.md`](./bot.md)), стоящем
выше middleware. Так же уходит и `critical` про упавший апдейт: `bot.catch` →
`Bot.handleError` вызывается не из `handleUpdate`, а из sink'а `@grammyjs/runner` — уже по
отклонённому промису `handleUpdate`, когда область свёрнута.

`RequestContext` (`platform/request-context/request-context.ts`) — единственная работа с
`AsyncLocalStorage`: сам ALS приватный, наружу уходят только операции над областью, а
`requestId` рождается внутри `run()`, а не у вызывающего. Поэтому ни middleware, ни
логгер не собирают стор руками и не знают его формы — иначе корреляция зависела бы от
того, одинаково ли они это делают.

Контекст общий, а не логгерный: экземпляр один и создаёт его `ApplicationContext`
([`application.md`](./application.md)). Логгеру он уходит аргументом конструктора там же,
до всякого контейнера; в контейнере (`Tokens.Bootstrap.RequestContext`) лежит ради
middleware. Ключи и тип стора — в `request-context.types.ts` рядом с ним
(`REQUEST_KEYS` с `as const`, `RequestStore` выведен из него, значения `unknown`).
`getValues()` отдаёт только известные ключи: без отбора формат лога зависел бы от того,
что в стор положили по дороге, а `as const` делает опечатку в ключе ошибкой компиляции, а
не молча потерянной корреляцией. Вне области `getRequestId()` — `null`, а не ошибка: у
`Runner` своей области нет, поэтому логи фоновых задач идут без `requestId`.

Наружу пишет только `Logger`. Прямой `console.*` минует уровень, `requestId` и порог
`LOGGER_LEVEL`, а в production — ещё и структурный поток pino, поэтому такая запись
теряется при разборе логов, а ошибка из `catch` превращается в тишину. Исключений два:
`ConsoleLogger`, для которого `console.*` — реализация порта, и фолбэк `fail()` в
`app.ts`: он зовётся и до создания контекста ([`application.md`](./application.md)).
Держит правило `no-console: "error"` в `.eslintrc.js`: адаптеру оно снято через
`overrides` вместе с его спекой (та снимает записи подменой `console`), а фолбэку —
точечными `eslint-disable-next-line`, а не файлом, поэтому третий `console.*` в `app.ts`
линтер поймает.

Payload перед записью проходит через `serialize-error`: без него вложенная ошибка
печаталась бы как `{}`, а так в лог попадают её `name`, `message`, `stack` и `cause`.

Пойманная ошибка уходит в payload только под ключом `cause` —
`logger.error(message, { cause: error })`, — и то же правило держат конструктор
`RuntimeError` и фабрики ошибок (`RuntimeError.byError()`, `ReadFailed.byPath()`,
`ProcessFailed.byCommand()`). Ключ payload — часть контракта записи, а не деталь вызова:
по нему ошибку ищут в логах и по нему её разберёт будущий ECS-маппинг, поэтому второй ключ
вроде `error` расколол бы такой разбор надвое молча — запись при этом выглядит целой. Тип
пойманного значения на выбор ключа не влияет: развилки «`Error` под `cause`, остальное под
`error`» нет ни в фабриках, ни в вызовах логгера.

От типа зависит не ключ, а глубина, на которой значение окажется в записи. Конструктор
`RuntimeError` поднимает `payload.cause` в нативный `cause`, только если это `Error`;
не-`Error` остаётся в payload. Разворачивать его `serialize-error` тоже не станет: в
`NonError` он заворачивает лишь собственный аргумент, а `PinoLogger` и `ConsoleLogger`
всегда передают ему объект payload, поэтому вложенные примитивы копируются как есть. Так
`ReadFailed.byPath(path, new Error("EACCES"))` кладёт исходное в `payload.cause.cause`
разобранной ошибкой, а `ReadFailed.byPath(path, "EACCES")` — в
`payload.cause.payload.cause` голой строкой. Разбор записи должен учитывать оба пути.
