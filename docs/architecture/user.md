# User

`telegram/user/`: the `User` entity with private fields and setters that bump
`updatedTime`; the `UserRepository` interface; `UserService.create()`/`edit()` wrapping
failures into `UserCreateError`/`UserEditError`; the `PgSqlUserRepository` adapter, whose
`save()` is an upsert, `on conflict (id) do update`.

`User` is not a user of the service but a snapshot of a Telegram profile, and that is why
the module lies in the Telegram directory: the columns are commented "in telegram" in the
`1660261075301_users-table.ts` migration, `isBot` means nothing outside Telegram, and the
whole entity is filled from `ctx.from` (`FillUserToContextMiddleware`).

The snapshot of a table row is a separate type, `UserRow`
(`pgsql-user-repository.types.ts`): snake_case, `Date` instead of `Dayjs` and `id` as a
string ([`storage.md`](./storage.md)) — the shape of the storage, not the vocabulary of the
entity, and only the adapter knows it.

`FillUserToContextMiddleware` on every update: `existsById` → `edit` (with
`lastActiveTime = now`) or `create` → `ctx.getUser()`. The check and the action are not
tied by a transaction; the only thing protecting them from a race is `sequentialize()`, and
only while nothing but private chats reaches the pipeline ([invariant](./invariants.md)).
`create()` does not guard against duplicates itself — it relies on the upsert.
`UserService.edit()` reads the user with `getById` before `save`: the `User` constructor
needs a whole `UserDto`, while `createdTime` does not come in an update and has no setter —
there is nothing to assemble the entity from on the spot.

The user lies in the context as a function, `ctx.getUser()`, and not as a field: a clone of
`User` would be an empty object, everything in the entity is in private fields
([invariant](./invariants.md)). Functions the conversations plugin does not clone but
restores bound to the live context, so inside a conversation `getUser()` returns the user of
the current update and not a snapshot taken when the conversation was entered.

`ctx.from` is filled here by the construction of the pipeline: updates without a session key
were dropped by `HasSessionKeyFilter` ([`bot.md`](./bot.md)). The `if (!ctx.from)` check
stays as an assertion — the compiler needs it, and it throws `UpdateWithoutFrom`
(`bot.errors.ts`) if the order in `Bot.setup()` is broken. `RequestLogMiddleware`
([`bot.md`](./bot.md)) logs the whole `ctx.update` at `debug` and increments
`session.requestCount`, which nothing reads.
