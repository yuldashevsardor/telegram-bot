# DI and the lifecycle

## DI

`Container extends InversifyContainer` (`container/container.ts`), and `setup()` is idempotent.
The config, the logger and the `RequestContext` it takes ready from `ApplicationContext` (below)
and binds first, in `setupBootstrap()`; after that by owner — `setupFontConvertor()`,
`setupTelegram()`, `setupPlatform()`. Everything is a singleton.

The symbols are `Symbol.for(...)` in a single dictionary, `shared/tokens.ts` (`Tokens`), and the
list of branches is there as well. A branch names the owner and a key the role inside it, so a
class name is repeated in a key only where the class has no role (`Tokens.Bot.Bot`). For what
comes ready from `ApplicationContext` the owner is whoever assembles the instance, not the
directory of the class: the logger and the `RequestContext` lie in the `Bootstrap` branch next to
`ConfigContainer`, although `RequestContext` and the logger themselves live in `platform/`. The
dictionary lies in `shared/` and not in `bootstrap/container/`: otherwise the domain would go to
the composition root for the name of its own dependency.

The registry is kept by hand ([invariant](./invariants.md)), and it stays silent in different
ways: a forgotten binding of a service gives nothing away for as long as nobody injects the
symbol — the first `@inject` fails the resolve with "No matching bindings found"; the pipeline
handlers are injected into the constructor of `Bot` ([`bot.md`](./bot.md)), so a symbol without a
binding fails the resolve of `Bot`, that is the start, and not the first update; a handler that is
not injected into `Bot`, on the other hand, never reaches the pipeline and says nothing about it,
binding or no binding. Before the start the first two cases are caught by
`test/bootstrap/container/container.spec.ts`: it assembles the container and resolves every token
of `Tokens`, so the same pass also fails on a second binding under one symbol ("Ambiguous match")
and on an `@inject` missed anywhere but the tail of a constructor ([invariant](./invariants.md)).
A class with no token in the dictionary, and a handler not injected into `Bot`, the spec does not
see. What is global is not the path in the object but the string inside `Symbol.for`; how it is
built and what a collision ends in is in the head of `shared/tokens.ts`. That is why
`Tokens.Bootstrap.RequestContext` and `Tokens.Bot.Middleware.RequestContext` share a name and
still do not collide.

The configuration takes no part in DI: a value is fetched by the function
`configValue("limits.common")` (`shared/config-value.ts`) — it takes the `ConfigContainer` from
`ApplicationContext` (below) and passes the dotted path to `ConfigContainer.get()`. It has no
token, no binding and no inversify: the configuration exists before the container, and there is
no point asking the container for it.

It stands as the default of a constructor parameter, and the parameter needs no marker:

```ts
public constructor(
    @inject<ConvertorFactory>(Tokens.Font.Convertor.Factory) private readonly convertorFactory: ConvertorFactory,
    private readonly tempDir: string = configValue("tempDir"),
) {}
```

A function rather than a decorator is not a matter of taste. A value is put into a constructor
parameter only by whoever calls `new`, while a parameter decorator can do no more than write
metadata for it: the return value of a legacy decorator is ignored, and stage-3 decorators have no
parameter decorators at all. So a "decorator on the parameter" would work only through the
container, which needs a token with a binding — that is, the configuration would be back in DI. An
ordinary call in the default makes the class itself the owner of the call, and no middleman is
needed.

This rests on `emitDecoratorMetadata` being off ([invariant](./invariants.md)): a parameter
without `@inject` is visible to inversify only through the emitted `design:paramtypes`, and
without them it takes the constructor to be described in full by its own `@inject` and never
reaches the default. The flag is off for another reason — nobody read the metadata anyway — but
switching it back on means breaking the resolve of all eight classes, and breaking it only in the
build.

Hence two properties. The value is read at construction and not on the first access to the
property, so a failure of the configuration falls on the start. And `new FontConvertor(factory,
"/tmp")` in a test substitutes its own value without touching `ApplicationContext` at all — the
former `@ConfigValue` needed the container to be up
(`test/telegram/outbound-queue/task-queue.spec.ts` substitutes nothing else any more).

The path is a string literal, but not an arbitrary one: its type, `ConfigPath`
(`bootstrap/config/container/config-container.types.ts`), is assembled from `ConfigValues`, and
the result type is derived from the same place (`ConfigValue` over `ValueByPath`). So the compiler
rejects both a miss in the path — a typo, a path through a primitive (`"tempDir.nope"`) — and a
declared type that does not match: `const x: string = configValue("limits.common")` does not
compile. The former `@ConfigValue<T>("key")` checked neither: the key was a string, the type a
hint at the call site, and inside stood three `as`. They are left in two places, both in
`bootstrap/config/container/config-container.ts`: the value `get()` found is cast to
`ValueByPath`, and for the same reason so is the pair of values that `onChange()` hands to a
listener ([`config.md`](./config.md)) — a walk by dots is not something the compiler can follow.
The walk itself needs no cast: it narrows the type with a guard.

`Container.close()` closes the Postgres pool and resets `alreadySetup`, but does not remove the
bindings: the container is single-use per process. A repeated `setup()` would pass silently, and
the duplicates would fail the very first resolve with "Ambiguous match" — including the resolve of
`Database` inside `close()` itself.

## Application

`ApplicationContext` (`bootstrap/application/context/application-context.ts`) is what the
application always needs: the config, the logger, the request context. These objects exist before
the container, because it cannot be assembled without them. The context assembles itself
(`ApplicationContext.create()`): inside are a `ConfigContainer` with a `ConfigValuesBuilder` and a
`ConfigFileStorage` over a `ConfigEnvStorage`, and its `init()` → `RequestContext` → the choice of
the logger adapter → the subscription of the logger to failed rebuilds of the configuration.
Watching the file was switched on by `init()` of the container already, but that opens no window
without an addressee: up to the subscription there is only synchronous code and the continuation
of an `await`, while the callback of the watcher is a separate task in the queue
([`config.md`](./config.md)).

The class is static through and through: the parts lie on it and are served by
`getConfigContainer()`, `getLogger()` and `getRequestContext()`, and there is no instance at all.
That way the context cannot be lost — a reference to an object would be impossible to recover, and
the assembled logger and storage would stay in the process with no entrance to them. An access
before `create()` is an `ApplicationContextIsNotCreated`.

There is one context per process: a second one would have a request storage of its own, and the
logger would read a store other than the one the middleware opened ([`logging.md`](./logging.md)),
so correlation would break silently. That is why a repeated `create()` is not an error but the
same assembly: `create()` is asynchronous (the config is assembled through `init()`) and holds the
promise of the assembly under way, so a call in the middle of it waits for that one instead of
assembling a second context. After the assembly the promise is forgotten whatever the outcome:
`create()` decides whether the context is assembled by the same value the getters use, otherwise
there would be two signs of readiness and a spec that reset the context would get one that
`create()` does not reassemble and the getters do not serve. That value is one for all three parts
(the `parts` field) rather than a field per part: it is only set once all of them are assembled, so
a `create()` that failed on the config leaves the context empty and the next one starts from
scratch, while a half-assembled context is not allowed by the type.

Beyond that the context goes nowhere: `Application.setup()` takes `cc` and `logger` from it,
`container.setup()` takes the three constants for its bindings. The consumers get the parts from
the container one by one: `Tokens.Bootstrap.Logger` and `Tokens.Bootstrap.RequestContext` through
`@inject`; `ConfigContainer` is bound under a token of its own but injected nowhere — its values
are taken straight from the context, past the container (above). The context is injected nowhere,
otherwise it would become a second DI. Its composition is kept short for the same reason:
`Database` is not part of it, it has a lifecycle of its own on `container.close()` (above).

`Application` (`bootstrap/application/application.ts`) is the lifecycle; it is created with `new`
in `app.ts` and does not appear in the container. The state of the cycle is a single `state` field
(the variants, and why not flags, are in the `State` type there). A `setup()` or a `stop()` under
way keeps its own promise in it, and a repeated call waits for that promise instead of going
through the step again. The instance is single-use: once the stop is over, neither `setup()` nor
`run()` nor `stop()` does anything. There is nothing to restart it with — the container does not
survive a second `setup()` after `close()` (above), and there is one `ApplicationContext` per
process.

### Start

**Trigger:** `node build/app.js` or `npm run dev`.

1. `app.ts` imports `reflect-metadata` — before any class with inversify decorators.
2. `application.setup()`:
   - `ApplicationContext.create()` — `dotenv.config()` inside `ConfigEnvStorage.load()`, once and
     explicitly, the values of the watched file on top of it, and then the parsing and the
     validation of the whole configuration ([`config.md`](./config.md)). `init()` of the container
     also switches on the watching of the file: an edit rebuilds the values, and the subscribers of
     its path get the new one (in the application there are none yet,
     [invariant](./invariants.md)).
     Inside the context the config is assembled before the logger (the adapter and the threshold
     both come from it), so an `InvalidConfigError` reaches `fail()` while there is no logger yet:
     that one writes through `ApplicationContext.getLogger()` and on an
     `ApplicationContextIsNotCreated` falls back to `console.error` ([`logging.md`](./logging.md)).
     The request scope is not open at start — it is opened by a middleware on every update
     ([`logging.md`](./logging.md)).
   - `container.setup()` — bindings only, the classes are not instantiated yet (above).
   - `Database.check()` — the first resolve of `Database`, so its constructor runs here as well
     ([`storage.md`](./storage.md)); `select 1` fails the start here and not on the first update.
   - `container.get()` for `TaskQueue`, `Runner` and `Bot`: together with `Bot`, before its
     constructor, all the handlers of the pipeline are instantiated ([`bot.md`](./bot.md)).
   - `Bot.setup()` — the assembly of the pipeline ([`bot.md`](./bot.md)); along the way the `.ftl`
     are read from disk ([`i18n.md`](./i18n.md)) and a `setMyCommands` goes over the network for
     every locale.

   A `setup()` that failed is not repeated by a second call, which gets the same failure instead:
   after a failure the process is ended by `fail()`.
3. `application.run()`: `runner.run()` is synchronous, it puts the loop of the queue on a
   `setTimeout` and returns at once ([`outbound-queue.md`](./outbound-queue.md)), and then
   `bot.run()` — long polling in the background ([`bot.md`](./bot.md)). Before `setup()` is over
   and on a running application it is a `RuntimeError`, after the stop has begun — nothing
   (below).

**Errors:** any failure of the start goes into `fail()` — a `critical` and an exit with code 1
(`bootstrap().catch(fail)`). Only `fail()` logs: two `critical` on one failure would double the
alert count, which is why `run()` on a failure silently stops the `runner` it has already started
and rethrows the error. `unhandledRejection` and `uncaughtException` lead to the same place. There
are no retries for the database or for `setMyCommands`: a temporary network failure at this moment
is fatal.

### Stop

**Trigger:** the first `SIGINT`/`SIGTERM` (`process.once`, a listener of its own per signal). A
repeated signal of the same kind finds no listener any more: Node applies the default action and
kills the process (130/143 instead of `exit(0)`) in the middle of a stop that has begun. A signal
of the other kind calls `gracefulStop()` again but does not start a second stop: its `stop()`
waits for the one under way (step 2), and both `exit(0)` fall at the end of it.

1. `gracefulStop()` → `application.stop()` → `process.exit(0)`; an error anywhere in the chain is
   a `fail()` and code 1.
2. `Application.stop()` before `setup()` and after the end of the stop does nothing. The watching
   of the configuration is removed at the beginning of `terminate()` (`cc.unwatch()`), before the
   overall deadline and outside it: once the deadline is over `terminate()` returns, and a poll
   left behind would rebuild the configuration of an application that is already closed
   ([invariant](./invariants.md)). The first call moves the application into the stop, and every
   following one during it waits for that same promise, and after it fails gets the same failure.
   The stop itself waits for `shutdown()` no longer than `GRACEFUL_SHUTDOWN_TIMEOUT`; once that is
   over it writes a `warning` and returns, while the abandoned step goes on running until
   `process.exit(0)` of step 1 cuts it short. `withTimeout()` swallows the failure of a late step,
   which would otherwise surface as an `unhandledRejection` after the stop.
3. A signal in the middle of `setup()`: first `stop()` waits for the assembly of
   `ApplicationContext` — outside the overall deadline, because both the deadline and the logger
   of the stop come from it; if the assembly failed, `stop()` hands that failure on. Then
   `shutdown()` waits for the rest of the setup — inside the overall deadline this time — and goes
   on to step 5. The bot is not running: `run()`, which `bootstrap()` calls right after the setup,
   does nothing and throws nothing once the stop has begun, otherwise `bootstrap()` would go into
   `fail()` with code 1. A failure of the setup itself is handed outwards by `stop()`: both
   `gracefulStop()` and `bootstrap()` come to `fail()` with one error, the first call ends the
   process synchronously — one `critical`, code 1.
4. `shutdown()`, if the application is running:
   - `Bot.stop()` — if the grammY runner is still working, its `stop()` within
     `BOT_GRACEFUL_SHUTDOWN_TIMEOUT`, and a `warning` if it did not make it. The source of updates
     is closed, there are no new `getUpdates`; the updates already handed to the pipeline,
     however, are not waited for by `stop()` — they play out in parallel with the remaining steps,
     and whatever did not make it is cut short by `process.exit(0)`.
   - `waitQueueToEmpty()` — polls `taskQueue.isEmpty()` every
     `TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL` up to `TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT` and logs
     what is left; on the deadline, a `warning` with the number of unfinished tasks. `isEmpty()`
     counts only what lies in the queue: a task the `Runner` has already taken is invisible to the
     counter.
   - `runner.stop()` — a flag and nothing more, the loop will leave on its next iteration
     ([`outbound-queue.md`](./outbound-queue.md)): `Runner.run()` and `Runner.stop()` are
     synchronous ([invariant](./invariants.md)).
5. `container.close()` → `Database.close()` → `sql.end({ timeout: 5 })`
   ([`storage.md`](./storage.md)).

The overall deadline has to be greater than the sum of the two individual ones
(`ConfigValuesBuilder` checks that) and smaller than the `stop_grace_period: 20s` of the container
— that one is not checked by anything ([invariant](./invariants.md)). The deadlines the dependencies
have of their own (`sql.end({ timeout: 5 })`) are not part of the check.

The tasks that did not make it out are lost together with the process.
