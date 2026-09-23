# Logging

The logger lives entirely in `platform/logger/`: the port is `logger.ts`, the levels `Level` and
their weights `LevelSeverity` are in `logger.types.ts`, and the adapters sit next to them. Which one
to build is decided by `ApplicationContext` ([`application.md`](./application.md)) at start, by
`isProduction` from the config ([`config.md`](./config.md)): `PinoLogger` in production,
`ConsoleLogger` otherwise. Both take the threshold from the common `AbstractLogger` but apply it
differently: `ConsoleLogger` checks `isEnabled`, while `PinoLogger` leaves filtering to pino, and
pino's cutoff matches the `AbstractLogger` threshold only because the custom pino levels are built
from the same `LevelSeverity`.

The threshold is `LOGGER_LEVEL`: that level and everything more severe is written; the default is
`WARNING` in production and `DEBUG` otherwise. An unknown value is an `InvalidConfigError`.

Request correlation: `RequestContextMiddleware` (the first middleware, [`bot.md`](./bot.md)) runs
the rest of the pipeline inside `requestContext.run(next)`. The common `AbstractLogger` takes a
`RequestContext` as a constructor dependency, and each adapter reads `getValues()` from it itself
at the moment of the write — `PinoLogger` puts the values as fields of the record next to `message`
and `payload`, `ConsoleLogger` prints them as `[key=value]` chips before the message. It is this
read that makes correlation work on both adapters, in development too; the logger itself is one per
process and is never swapped.

The scope of `run()` is what stands below `RequestContextMiddleware` in the pipeline and nothing
else, so everything written outside it goes without a `requestId`. The filters, `sequentialize()`
and `session()` stand above the middleware ([`bot.md`](./bot.md)), so they run outside the scope,
and the record the base `Filter` writes when it drops an update goes out that way too. So does the
`critical` about a failed update: `grammy.catch` → `Bot.handleError` is called not from
`handleUpdate` but from the sink of `@grammyjs/runner` — on the already rejected promise of
`handleUpdate`, when the scope is closed.

`RequestContext` (`platform/request-context/request-context.ts`) is the only code that touches
`AsyncLocalStorage`: the ALS itself is private, only operations on the scope go outside, and the
`requestId` is born inside `run()`, not at the caller. So neither the middleware nor the logger
builds the store by hand or knows its shape — otherwise correlation would depend on whether they
do it the same way.

The context is shared, not the logger's own: there is one instance, created by
`ApplicationContext` ([`application.md`](./application.md)). The logger gets it as a constructor
argument right there, before any container; it sits in the container
(`Tokens.Bootstrap.RequestContext`) for the middleware. The keys and the store type are in
`request-context.types.ts` next to it (`REQUEST_KEYS` with `as const`, `RequestStore` derived from
it, values `unknown`). `getValues()` returns only the known keys: without that filter the log format
would depend on what was put into the store along the way, and `as const` makes a typo in a key a
compile error rather than silently lost correlation. Outside a scope `getValues()` is `{}` and
`getRequestId()` is `null`, not an error. The outbound queue's `Runner`
(`telegram/outbound-queue/runner/runner.ts`) runs outside any scope: it calls `task.callback()` from
its own `setTimeout` loop, not from the update that enqueued the task. So the two `error` records
the `Runner` itself writes about a failed API call ([`outbound-queue.md`](./outbound-queue.md),
"Errors") go without a `requestId` even when an update made the call.

Only `Logger` writes outwards. A direct `console.*` bypasses the level, the `requestId` and the
`LOGGER_LEVEL` threshold, and in production the structured pino stream as well, so such a record is
lost when the logs are parsed, and an error from a `catch` turns into silence. There are two
exceptions: `ConsoleLogger`, for which `console.*` is the implementation of the port, and the
`fail()` fallback in `app.ts`, which is also called before the context is created
([`application.md`](./application.md)). The rule is held by `no-console: "error"` in `.eslintrc.js`:
the adapter is exempted through `overrides` together with its spec (which captures the records by
replacing `console`), and the fallback by line-level `eslint-disable-next-line` rather than for the
whole file, so a third `console.*` in `app.ts` is caught by the linter.

The payload goes through `serialize-error` before the write: without it a nested error would print
as `{}`, with it the log gets its `name`, `message`, `stack` and `cause`.

A caught error goes into the payload only under the `cause` key —
`logger.error(message, { cause: error })` — and the constructor of `RuntimeError` and the error
factories (`RuntimeError.byError()`, `ReadFailed.byPath()`, `ProcessFailed.byCommand()`) keep the
same rule. The payload key is part of the record's contract, not a detail of the call: errors are
searched for in the logs by it, and a future ECS mapping
([#128](https://github.com/yuldashevsardor/telegram-bot/issues/128)) will parse them by it, so a
second key such as `error` would split that parsing in two silently — the record itself still
looks whole. The type of the caught value does not affect the choice of key: there is no "`Error`
under `cause`, the rest under `error`" branch in the factories or in the logger calls.

The type decides not the key but the depth at which the value ends up in the record. The
`RuntimeError` constructor lifts `payload.cause` into the native `cause` only if it is an `Error`; a
non-`Error` stays in the payload. `serialize-error` will not expand it either: it wraps into
`NonError` only its own argument, and `PinoLogger` and `ConsoleLogger` always pass it the payload
object, so nested primitives are copied as they are. Thus
`ReadFailed.byPath(path, new Error("EACCES"))` puts the original into `payload.cause.cause` as a
parsed error, and `ReadFailed.byPath(path, "EACCES")` into `payload.cause.payload.cause` as a bare
string. Parsing a record has to account for both paths.
