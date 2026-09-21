# Storage

`Database` (`platform/database/database.ts`) wraps `postgres`; the pool is created in the
constructor and the connection is opened lazily, which is why `Application.setup()` calls
`check()`. `debug: !isProduction` is not query logging: `debug` in postgres is a callback
and not a flag, and the driver itself prints nothing; with `true` it only makes the fields
of a failed query's error enumerable, `query` and `parameters` among them, and they end up
in the `payload` of the log.

Migrations are `node-pg-migrate` (`migrate.json`, the `migrations/` directory in the root);
they are applied by the same container before the bot starts. Migrations are append-only
([`invariants.md`](./invariants.md)).

The directory lies outside `src/` deliberately: the application does not import migrations,
`node-pg-migrate` loads them with its own jiti straight from the sources, and in `build/`
they were dead weight. The `tsconfig-paths` key in `migrate.json` is an option of that jiti
and not the npm package of the same name (the project does not depend on it).
The checks see the directory all the same: it is listed in each of them separately — the
`include` of `tsconfig.check.json`, the arguments of the `lint` and `format:check` npm
scripts, its own `overrides` in `.eslintrc.js`.

`common/template.ts` is the stub `migrate-create` builds a migration file from. It lies in
a subdirectory, and that alone is enough for `node-pg-migrate` not to see it: it reads the
migrations directory without recursion and skips subdirectories (which is also why no
`ignore-pattern` is needed in `migrate.json`). Its `./common/utils` import is written not
for its own place but for the directory it will be copied into.

It is excluded from the checks in one place — the `exclude` of `tsconfig.check.json`: that
import does not resolve from where the stub lies. There is nowhere else to exclude it from:
the `up`/`down` parameter is named `_pgm`, and such a name is let through by both
`noUnusedParameters` and the eslint `argsIgnorePattern`, so the empty bodies of the stub
need neither a placeholder inside it nor an exception for a freshly created migration — it
passes `make check` right away, before the first line of a body is written. Once the body
is written, `_pgm` is renamed to `pgm`. The `.ts` extension is mandatory: `node-pg-migrate`
takes the extension of the file it creates from the name of the stub.

`sessions` is written by `PgsqlStorage` (`telegram/session/pgsql-storage.ts`) directly, with
a positional `insert into sessions values (key, value)` — two values for four columns: a
column added by a migration before `value` will be silently shifted by the query
([`invariants.md`](./invariants.md)).

It has no storage interface of its own, and that is deliberate: only `users` has one. There
the interface is declared by the consumer itself — `UserRepository`
(`telegram/user/user-repository.ts`) is written for the needs of `UserService`, which is
also its caller. For the session the interface is set from outside: `PgsqlStorage`
implements grammY's `StorageAdapter<SessionPayload>`, because that is exactly the type
`session()` takes in `Bot.setupSession()`. An interface of our own would be a renaming of a
foreign one that nobody calls and nothing can substitute.

Hence the pattern for the next storage: an interface is introduced when a consumer dictates
it and is not introduced when a library does. Both parts lie next to the consumer either
way — `telegram/user/` and `telegram/session/` — and there is no separate layer for storage
adapters: `PgSqlUserRepository` has a directory of its own with a companion
(`telegram/user/pgsql-repository/`), but inside the subsystem of the consumer.

`User.id` is a JS `number` against a `bigint` in the database (the third migration widened
the column from `int4`); that is exact up to `2^53 - 1`, and current Telegram IDs fit.
Without a `types` setting the driver returns `bigint` as a string, so `UserRow.id` is a
`string`, and `PgSqlUserRepository.rowToEntity()` turns it into a number. The
`sql<UserRow[]>` parameter is only a type assertion: the compiler does not check it against
what arrives, and while `UserRow` said `number`, a string silently made it all the way into
`User.id`.
