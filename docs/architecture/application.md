# DI and the lifecycle

## DI

`Container` (`bootstrap/container/container.ts`) extends `InversifyContainer`, and its `setup()` is
idempotent. It binds first, in `setupBootstrap()`, the config, the logger and the
`RequestContext`, taken ready from `ApplicationContext` (below). After that it binds by owner:
`setupFontConvertor()`, `setupTelegram()`, `setupPlatform()`. Everything is a singleton.

The tokens are `Symbol.for(...)` in one dictionary, `Tokens` in `shared/tokens.ts`, which also
lists the branches. It lies in `shared/` and not in `bootstrap/container/`: otherwise the domain
would go to the composition root for the name of its own dependency.

A branch names the owner, and a key names the role inside it. A key repeats the class name only
where the class has no role (`Tokens.Bot.Bot`). For what comes ready from `ApplicationContext`,
the owner is whoever assembles the instance, not the directory of the class. So the logger and
the `RequestContext` lie in the `Bootstrap` branch next to `ConfigContainer`, although both
classes live in `platform/`.

The registry is kept by hand ([invariant](./invariants.md)), and its mistakes stay silent in
different ways:

- A forgotten binding of a service gives nothing away until someone injects its symbol. The first
  `@inject` then fails the resolve with "No matching bindings found".
- A pipeline handler without a binding fails the start, not the first update. The handlers are
  injected into the constructor of `Bot` ([`bot.md`](./bot.md)), so the resolve of `Bot` fails.
- A handler not injected into `Bot` never reaches the pipeline, with a binding or without, and
  nothing reports it.

`test/bootstrap/container/container.spec.ts` catches the first two cases before the start: it
assembles the container and resolves every token of `Tokens`. The same pass fails on a second
binding under one symbol ("Ambiguous match") and on an `@inject` missed anywhere but the tail of a
constructor ([invariant](./invariants.md)). The spec does not see a class with no token in
`Tokens`, nor a handler not injected into `Bot`.

The global key is the string inside `Symbol.for`, not the path in the object. The head of
`shared/tokens.ts` says how the string is built and what a collision ends in. That is why
`Tokens.Bootstrap.RequestContext` and `Tokens.Bot.Middleware.RequestContext` share a name and
still do not collide.

The configuration takes no part in DI. A value is fetched by the function
`configValue("limits.common")` (`shared/config-value.ts`): it takes the `ConfigContainer` from
`ApplicationContext` (below) and passes the dotted path to `ConfigContainer.get()`. There is no
token, no binding and no inversify: the configuration exists before the container, so there is no
point asking the container for it.

The call stands as the default of a constructor parameter, and the parameter needs no marker:

```ts
public constructor(
    @inject<ConvertorFactory>(Tokens.Font.Convertor.Factory) private readonly convertorFactory: ConvertorFactory,
    private readonly tempDir: string = configValue("tempDir"),
) {}
```

A function and not a decorator, because a decorator cannot put the value in:

- Only whoever calls `new` puts a value into a constructor parameter.
- A parameter decorator can only write metadata. A legacy decorator's return value is ignored,
  and stage-3 decorators have no parameter decorators at all.
- So a decorator on the parameter would work only through the container. The container needs a
  token with a binding, and the configuration would be back in DI.

A call in the default makes the class itself the caller, with no middleman.

This rests on `emitDecoratorMetadata` being off ([invariant](./invariants.md)). Inversify sees a
parameter without `@inject` only through the emitted `design:paramtypes`. Without them it takes
the constructor to be described in full by its `@inject`s and never reaches the default. The flag
was switched off for another reason: nobody read the metadata. But switching it back on breaks the
resolve of every such class, and only in the build.

Two properties follow:

- The value is read at construction, not on the first access to the property, so a failure of the
  configuration falls on the start.
- A test passes its own value, `new FontConvertor(factory, "/tmp")`, without touching
  `ApplicationContext`. The former `@ConfigValue` needed the container to be up;
  `test/telegram/outbox/outbox-store.spec.ts` passes the limits of `OutboxStore` the same way.

The path is a string literal, but not an arbitrary one. Its type, `ConfigPath`
(`bootstrap/config/container/config-container.types.ts`), is built from `ConfigValues`, and the
result type comes from the same place (`ConfigValue` over `ValueByPath`). So the compiler rejects
a wrong path: a typo, or a path through a primitive (`"tempDir.nope"`). It also rejects a declared
type that does not match: `const x: string = configValue("limits.common")` does not compile. The
former `@ConfigValue<T>("key")` checked neither: the key was a string, the type a hint at the call
site, and inside stood three `as`.

Three `as` are left, all in `bootstrap/config/container/config-container.ts`: `get()` casts the
value it found to `ValueByPath`, and `onChange()` casts the pair of values it hands to a listener
([`config.md`](./config.md)). The reason is the same for both: the compiler cannot follow a walk
by dots. The walk itself needs no cast, because it narrows the type with a guard.

The container is single-use per process. `Container.close()` stops the outbox result waiter
([`outbox.md`](./outbox.md), "Waiting for the result"; `Application` has stopped it already),
closes the Postgres pool and resets
`alreadySetup`, but keeps the bindings. A repeated `setup()` would pass silently, and the
duplicates would fail the very first resolve with "Ambiguous match". That includes the resolve of
`Database` inside `close()` itself.

## Application

`ApplicationContext` (`bootstrap/application/context/application-context.ts`) holds what the
application always needs: the config, the logger, the request context. These objects exist before
the container, because the container cannot be assembled without them.

`ApplicationContext.create()` assembles the context in this order:

1. a `ConfigContainer` with a `ConfigValuesBuilder` and a `ConfigFileStorage` over a
   `ConfigEnvStorage`, and its `init()`;
2. the `RequestContext`;
3. the logger, with the adapter chosen by the config;
4. the logger's subscription to failed rebuilds of the configuration.

`init()` already switches on watching the file, but that leaves no window where a failed rebuild
has no listener. Up to step 4 there is only synchronous code and the continuation of an `await`,
while the watcher's callback is a separate task in the queue ([`config.md`](./config.md)).

The class is fully static. The parts lie on it, `getConfigContainer()`, `getLogger()` and
`getRequestContext()` serve them, and there is no instance. So the context cannot be lost: a lost
reference to an instance could not be recovered, and the assembled logger and storage would stay
in the process with no way to reach them. An access before `create()` throws
`ApplicationContextIsNotCreated`.

There is one context per process. A second one would have a request storage of its own, and the
logger would read a store other than the one the middleware opened ([`logging.md`](./logging.md)).
Correlation would break silently.

That is why a repeated `create()` is not an error but the same assembly. `create()` is
asynchronous (the config is assembled through `init()`) and keeps the promise of the assembly in
progress. A call in the middle waits for that promise instead of assembling a second context.

After the assembly the promise is dropped, whatever the outcome. `create()` decides whether the
context is assembled by the same value the getters read. A kept promise would be a second sign of
readiness: a spec that reset the context would get one that `create()` does not reassemble and the
getters do not serve.

That value is one field for all three parts (`parts`), not a field per part. It is set only once
all of them are assembled. So a `create()` that failed on the config leaves the context empty, and
the next one starts from scratch. The type does not allow a half-assembled context.

Beyond that the context goes nowhere. `Application.setup()` takes `cc` and `logger` from it, and
`container.setup()` takes the three parts for its bindings. The consumers get the parts from the
container one by one:

- `Tokens.Bootstrap.Logger` and `Tokens.Bootstrap.RequestContext` through `@inject`;
- `ConfigContainer` is bound under a token of its own but injected nowhere: its values are taken
  from the context, past the container (`configValue`, above).

The context itself is injected nowhere, otherwise it would become a second DI. For the same reason
its composition stays short: `Database` is not part of it and has a lifecycle of its own in
`container.close()` (above).

`Application` (`bootstrap/application/application.ts`) is the lifecycle. `app.ts` creates it with
`new`, and it does not appear in the container. The state of the cycle is one field, `state`; the
variants, and why not flags, are in the `State` type there. A `setup()` or a `stop()` in progress
keeps its promise in it, and a repeated call waits for that promise instead of running the step
again.

The instance is single-use: once the stop is over, `setup()`, `run()` and `stop()` do nothing.
There is nothing to restart it with: the container does not survive a second `setup()` after
`close()` (above), and there is one `ApplicationContext` per process.

### Start

**Trigger:** `node build/app.js` or `npm run dev`.

1. `app.ts` imports `reflect-metadata` before any class with inversify decorators.
2. `application.setup()`:
   - `ApplicationContext.create()` builds the configuration ([`config.md`](./config.md)).
     `ConfigEnvStorage.load()` calls `dotenv.config()` explicitly, here and again on every rebuild.
     The values of the watched file lie under the environment: a variable set there non-blank wins.
     Then the whole configuration is parsed and validated.
   - `init()` of the config container also switches on watching the file. An edit rebuilds the
     values, and the subscribers of its path get the new one (the application has none yet,
     [invariant](./invariants.md)).
   - The context assembles the config before the logger, because the adapter and the threshold
     both come from the config. So an `InvalidConfigError` reaches `fail()` while there is no
     logger yet. `fail()` writes through `ApplicationContext.getLogger()` and on an
     `ApplicationContextIsNotCreated` falls back to `console.error` ([`logging.md`](./logging.md)).
   - The request scope is not open at start. A middleware opens it on every update
     ([`logging.md`](./logging.md)).
   - `container.setup()` only binds; the classes are not instantiated yet (above).
   - `Database.check()` is the first resolve of `Database`, so its constructor runs here as well
     ([`storage.md`](./storage.md)). Its `SELECT 1` fails the start here and not on the first
     update.
   - `container.get()` for the services of `assemble()`. All the handlers of the pipeline are
     instantiated together with `Bot`, before its constructor ([`bot.md`](./bot.md)).
   - `Bot.setup()` installs the outbox transformer and assembles the pipeline
     ([`bot.md`](./bot.md)). Along the way it reads the `.ftl` from disk ([`i18n.md`](./i18n.md))
     and sends a `setMyCommands` over the network for every locale, straight to Telegram: the call
     has no chat.

   A second `setup()` does not repeat a failed one; it gets the same failure. After a failure
   `fail()` ends the process.
3. `application.run()` starts, with no `await` in between, in this order:
   - `OutboxRunner.start()` and `OutboxMaintenance.start()`: the sending of the outbox and its
     timers ([`outbox.md`](./outbox.md), "The runner", "Maintenance"). First, since the handlers of
     the updates await the results of the outbox;
   - `InboxRunner.start()` and `InboxMaintenance.start()`: the handling of the inbox through the bot
     and its timers ([`inbox.md`](./inbox.md), "The runner", "Maintenance");
   - `InboxPollingSource.start()`: long polling into the inbox, in the background
     ([`inbox.md`](./inbox.md), "The polling source").

   Every start is synchronous, so a stop comes before all of them or after all of them. A stop that
   comes first leaves `run()` doing nothing (below).

   `run()` throws a `RuntimeError` before `setup()` is over and on a running application. After
   the stop has begun it does nothing (below).

**Errors:** any failure of the start goes into `fail()` (`bootstrap().catch(fail)`): a `critical`
and exit code 1. `unhandledRejection` and `uncaughtException` lead there too. Only `fail()` logs:
two `critical` on one failure would double the alert count. That is why `setup()` and `run()` throw
a failure without logging it. There are no retries for the database or for `setMyCommands`: a
temporary network failure at this moment is fatal. The polling source meets Telegram only after the
start, in the background, and retries its failures itself ([`inbox.md`](./inbox.md), "The polling
source").

### Stop

**Trigger:** the first `SIGINT` or `SIGTERM` (`process.once`, a listener of its own per signal).

- A repeated signal of the same kind finds no listener. Node applies the default action and kills
  the process in the middle of the stop: code 130/143 instead of `exit(0)`.
- A signal of the other kind calls `gracefulStop()` again but does not start a second stop. Its
  `stop()` waits for the stop in progress (step 2), and both `exit(0)` come at its end.

1. `gracefulStop()` → `application.stop()` → `process.exit(0)`. An error anywhere in the chain
   goes into `fail()`, with code 1.
2. `Application.stop()` does nothing before `setup()` and after the stop is over.
   - The first call moves the application into the stop. Every later call during the stop waits
     for the same promise, and if the stop failed, gets the same failure.
   - `terminate()` starts with `cc.unwatch()`, before the overall deadline and outside it. Once
     the deadline is over `terminate()` returns, and a poll left behind would rebuild the
     configuration of a closed application ([invariant](./invariants.md)).
   - The stop waits for `shutdown()` no longer than `GRACEFUL_SHUTDOWN_TIMEOUT`. After that it
     writes a `warning` and returns. The abandoned step goes on running until the
     `process.exit(0)` of step 1 cuts it short.
   - `withTimeout()` swallows the failure of a late step. Otherwise it would surface as an
     `unhandledRejection` after the stop.
3. A signal in the middle of `setup()`:
   - `stop()` first waits for the assembly of `ApplicationContext`, outside the overall deadline:
     both the deadline and the logger of the stop come from the context. If the assembly failed,
     `stop()` hands that failure on.
   - Then `shutdown()` waits for the rest of the setup, inside the overall deadline this time, and
     goes on to step 5.
   - Nothing is started. `bootstrap()` calls `run()` right after the setup, and once the stop
     has begun `run()` does nothing and throws nothing. Otherwise `bootstrap()` would go into
     `fail()` with code 1.
   - `stop()` hands a failure of the setup itself outwards. `gracefulStop()` and `bootstrap()`
     both come to `fail()` with the one error, and the first call ends the process synchronously:
     one `critical`, code 1.
4. `shutdown()`, if the application is running, stops in the reverse order of the start:
   - `InboxPollingSource.stop()`: no new `getUpdates`, and a push in flight is awaited. The source
     has no deadline of its own, so `shutdown()` waits for it no longer than
     `INBOX_POLLING_STOP_TIMEOUT` and writes a `warning` if that did not make it; a push left behind
     is cut off by the closing of the pool in step 5 ([`inbox.md`](./inbox.md), "The polling
     source").
   - `InboxRunner.stop()` takes no more updates, waits for the handlers in flight up to
     `INBOX_STOP_TIMEOUT` and leaves the rest running ([`inbox.md`](./inbox.md), "The runner").
     Before the outbox: the handlers in flight await its results.
   - `InboxMaintenance.stop()` clears the timers and waits for the runs in progress, with no
     deadline of its own ([`inbox.md`](./inbox.md), "Maintenance").
   - `OutboxRunner.stop()` stops the pulls, waits for the calls in flight up to
     `OUTBOX_STOP_TIMEOUT` and aborts the rest, handing their messages to the other nodes
     ([`outbox.md`](./outbox.md), "The runner"). A call the handlers left running push after that
     stays queued for another node or the next start; its caller waits until the next item stops
     the waiter.
   - `OutboxResultWaiter.stop()` rejects the waits of the handlers `InboxRunner.stop()` left
     running, and `InboxRunner.waitForHandlersLeftRunning()` waits until each of those has released
     its update ([`inbox.md`](./inbox.md), "Release on stop"). After the outbox runner, which still
     sends the calls those waits await, and before the pool closes, which the releases need. The
     handlers left running have no deadline of their own, so this wait lives on the overall one: a
     handler that never settles holds the stop to it.
   - `OutboxMaintenance.stop()` clears the timers and waits for the runs in progress, with no
     deadline of its own ([`outbox.md`](./outbox.md), "Maintenance").
5. `container.close()` → `OutboxResultWaiter.stop()` again, which changes nothing after step 4 and
   serves a container closed without a running application, then `Database.close()` →
   `sql.end({ timeout: 5 })` ([`storage.md`](./storage.md)).

The overall deadline has to be greater than the sum of the individual ones of the polling source,
the inbox runner and the outbox runner, and `ConfigValuesBuilder` checks that. It also has to be
smaller than the container's `stop_grace_period: 25s`, and nothing checks that
([invariant](./invariants.md)). The dependencies' own deadlines (`sql.end({ timeout: 5 })`) are
not part of the check.

The outbox messages that did not go out stay in their tables for another node or the next start,
and so do the inbox updates that were not handled.
