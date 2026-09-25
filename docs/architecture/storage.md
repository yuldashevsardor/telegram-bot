# Storage

`Database` (`platform/database/database.ts`) wraps `postgres`. The pool is created in the
constructor, and the connection is opened lazily. That is why `Application.setup()` calls
`check()`.

`debug: !isProduction` is not query logging. In postgres `debug` is a callback, not a flag, and
the driver itself prints nothing. With `true` it only makes the fields of a failed query's error
enumerable, `query` and `parameters` among them. They end up in the `payload` of the log.

## Migrations

Migrations are `node-pg-migrate` (`migrate.json`, the `migrations/` directory in the root). The
same container applies them before the bot starts. Migrations are append-only
([`invariants.md`](./invariants.md)).

The directory lies outside `src/` on purpose. The application does not import migrations:
`node-pg-migrate` loads them straight from the sources with its own jiti, and in `build/` they
were dead weight. The `tsconfig-paths` key in `migrate.json` is an option of that jiti. It is not
the npm package of the same name, and the project does not depend on that package.

The checks still see the directory, because each of them lists it separately:

- the `include` of `tsconfig.check.json`;
- the arguments of the `lint` and `format:check` npm scripts;
- its own `overrides` entry in `.eslintrc.js`.

`common/template.ts` is the stub `migrate-create` builds a migration file from. Lying in a
subdirectory is enough to hide it from `node-pg-migrate`: that reads the migrations directory
without recursion and skips subdirectories. That is also why `migrate.json`
needs no `ignore-pattern`. The stub's `./common/utils` import is written for the directory the
stub is copied into, not for its own place.

The checks exclude the stub in one place, the `exclude` of `tsconfig.check.json`, because that
import does not resolve from where the stub lies.

Nothing else needs an exclusion. The `up`/`down` parameter is named `_pgm`, and both
`noUnusedParameters` and the eslint `argsIgnorePattern` let such a name through. So the empty
bodies need no placeholder in the stub and no exception for a fresh migration: it passes
`make check` right away, before the first line of a body is written. Once the body is written,
`_pgm` is renamed to `pgm`.

The stub's `.ts` extension is mandatory: `node-pg-migrate` takes the extension of the file it
creates from the name of the stub.

## Sessions

`PgsqlStorage` (`telegram/session/pgsql-storage.ts`) writes `sessions` directly, with a
positional `insert into sessions values (key, value)`: two values for four columns. So if a
migration adds a column before `value`, the query silently shifts the values
([`invariants.md`](./invariants.md)).

## When a storage gets an interface

`PgsqlStorage` has no storage interface of its own, on purpose. Only `users` has one:

- For `users` the consumer declares the interface itself. `UserRepository`
  (`telegram/user/user-repository.ts`) is written for the needs of `UserService`, which is also
  its caller.
- For the session a library sets the interface. `PgsqlStorage` implements grammY's
  `StorageAdapter<SessionPayload>`, because that is exactly the type `session()` takes in
  `Bot.setupSession()`. An interface of our own would only rename a foreign one: nobody would
  call it, and nothing could substitute it.

Hence the rule for the next storage: an interface is introduced when a consumer dictates it, and
not when a library does.

Either way the storage lies next to its consumer, in `telegram/user/` and `telegram/session/`.
There is no separate layer for storage adapters. `PgSqlUserRepository` has a directory of its own
with a companion (`telegram/user/pgsql-repository/`), but inside the subsystem of the consumer.

## `User.id`

`User.id` is a JS `number`, while the column is a `bigint`: the third migration widened it from
`int4`. A `number` is exact up to `2^53 - 1`, and current Telegram IDs fit.

Without a `types` setting the driver returns `bigint` as a string. So `UserRow.id` is a `string`,
and `PgSqlUserRepository.rowToEntity()` turns it into a number. The `sql<UserRow[]>` type
argument is only an assertion: the compiler does not check it against what arrives. While
`UserRow` said `number`, a string silently made it all the way into `User.id`.
