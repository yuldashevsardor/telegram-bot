# Logging

## The port and the adapters

The logger lives entirely in `platform/logger/`:

- the port is `logger.ts`;
- the levels `Level` and their weights `LevelSeverity` are in `logger.types.ts`;
- the adapters sit next to them.

`ApplicationContext` ([`application.md`](./application.md)) picks the adapter at start by
`isProduction` from the config ([`config.md`](./config.md)): `PinoLogger` in production,
`ConsoleLogger` otherwise.

Both adapters take the threshold from the common `AbstractLogger`, but apply it differently:

- `ConsoleLogger` checks `isEnabled`.
- `PinoLogger` leaves filtering to pino. Pino's cutoff matches the `AbstractLogger` threshold only
  because the custom pino levels are built from the same `LevelSeverity`.

The threshold is `LOGGER_LEVEL`: that level and everything more severe is written. The default is
`WARNING` in production and `DEBUG` otherwise. An unknown value is an `InvalidConfigError`.

## Request correlation

`RequestContextMiddleware` (the first middleware, [`bot.md`](./bot.md)) runs the rest of the
pipeline inside `requestContext.run(next)`. The common `AbstractLogger` takes a `RequestContext`
as a constructor dependency. Each adapter reads `getValues()` from it itself, at the moment of the
write:

- `PinoLogger` puts the values as fields of the record, next to `message` and `payload`;
- `ConsoleLogger` prints them as `[key=value]` chips before the message.

This read is what makes correlation work on both adapters, in development too. The logger itself
is one per process and is never swapped.

### Records without a `requestId`

The scope of `run()` is only what stands below `RequestContextMiddleware` in the pipeline.
Everything written outside it goes without a `requestId`:

- The filters, `sequentialize()` and `session()` stand above the middleware
  ([`bot.md`](./bot.md)), so they run outside the scope. That includes the record the base
  `Filter` writes when it drops an update.
- The `critical` about a failed update goes out that way too. `grammy.catch` → `Bot.handleError` is called not from
  `handleUpdate` but from the sink of `@grammyjs/runner`. It runs on the already rejected promise
  of `handleUpdate`, when the scope is closed.
- The outbound queue's `Runner` (`telegram/outbound-queue/runner/runner.ts`) runs outside any
  scope. It calls `task.callback()` from its own `setTimeout` loop, not from the update that
  enqueued the task. So the two `error` records the `Runner` itself writes about a failed API call
  ([`outbound-queue.md`](./outbound-queue.md#errors)) go without a `requestId`, even when an
  update made the call.

### `RequestContext`

`RequestContext` (`platform/request-context/request-context.ts`) is the only code that touches
`AsyncLocalStorage`:

- the ALS itself is private, and only operations on the scope go outside;
- the `requestId` is born inside `run()`, not at the caller.

So neither the middleware nor the logger builds the store by hand or knows its shape. Otherwise
correlation would depend on whether they build it the same way.

The context is shared, not the logger's own. There is one instance, created by
`ApplicationContext` ([`application.md`](./application.md)). The logger gets it right there as a
constructor argument, before any container. It also sits in the container
(`Tokens.Bootstrap.RequestContext`) for the middleware.

The keys and the store type are in `request-context.types.ts` next to it: `REQUEST_KEYS` with
`as const`, `RequestStore` derived from it, the values `unknown`.

- `getValues()` returns only the known keys. Without that filter the log format would depend on
  what was put into the store along the way.
- `as const` makes a typo in a key a compile error rather than silently lost correlation.
- Outside a scope `getValues()` is `{}` and `getRequestId()` is `null`, not an error.

## Only `Logger` writes outwards

A direct `console.*` bypasses the level, the `requestId` and the `LOGGER_LEVEL` threshold. In
production it bypasses the structured pino stream as well. So such a record is lost when the logs
are parsed, and an error from a `catch` turns into silence.

There are two exceptions:

- `ConsoleLogger`: for it `console.*` is the implementation of the port.
- The `fail()` fallback in `app.ts`, for when the record cannot go through the logger. That is
  before `ApplicationContext` is assembled ([`application.md`](./application.md)), and when the
  write of the logger itself throws.

The rule is held by `no-console: "error"` in `.eslintrc.js`:

- The adapter is exempted through `overrides`, together with its spec. The spec captures the
  records by replacing `console`.
- The fallback is exempted by a line-level `eslint-disable-next-line`, not for the whole file. So a
  third `console.*` in `app.ts` is caught by the linter.

## Errors in the payload

The payload goes through `serialize-error` before the write. Without it a nested error would print
as `{}`. With it the log gets the error's `name`, `message`, `stack` and `cause`.

A caught error goes into the payload only under the `cause` key:
`logger.error(message, { cause: error })`. The constructor of `RuntimeError` and the error
factories keep the same rule: `RuntimeError.byError()`, `ReadFailed.byPath()`,
`ProcessFailed.byCommand()`.

The payload key is part of the record's contract, not a detail of the call:

- errors are searched for in the logs by it;
- a future ECS mapping ([#128](https://github.com/yuldashevsardor/telegram-bot/issues/128)) will
  parse them by it.

So a second key such as `error` would split that parsing in two silently, while the record itself
still looks whole. The type of the caught value does not change the key: neither the factories nor
the logger calls have an "`Error` under `cause`, the rest under `error`" branch.

The type decides not the key but the depth at which the value lands in the record:

- The `RuntimeError` constructor lifts `payload.cause` into the native `cause` only if it is an
  `Error`. A non-`Error` stays in the payload.
- `serialize-error` does not expand it either. It wraps into `NonError` only its own argument, and
  `PinoLogger` and `ConsoleLogger` always pass it the payload object. So nested primitives are
  copied as they are.

So `ReadFailed.byPath(path, new Error("EACCES"))` puts the original into `payload.cause.cause` as a
parsed error. `ReadFailed.byPath(path, "EACCES")` puts it into `payload.cause.payload.cause` as a
bare string. Parsing a record has to account for both paths.
