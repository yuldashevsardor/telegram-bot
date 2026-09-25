# User

`telegram/user/` holds:

- the `User` entity: its fields are private, and its setters bump `updatedTime`;
- the `UserRepository` interface;
- `UserService.create()`/`edit()`, which wrap failures into `UserCreateError`/`UserEditError`;
- the `PgSqlUserRepository` adapter: its `save()` is an upsert, `on conflict (id) do update`.

`User` is not a user of the service but a snapshot of a Telegram profile. That is why the module
lies in the Telegram directory:

- the `1660261075301_users-table.ts` migration comments the columns "in telegram";
- `isBot` means nothing outside Telegram;
- the whole entity is filled from `ctx.from` (`FillUserToContextMiddleware`).

A table row has a type of its own, `UserRow` (`pgsql-user-repository.types.ts`). It is the shape
of the storage, not the vocabulary of the entity: snake_case, `Date` instead of `Dayjs`, and `id`
as a string ([`storage.md`](./storage.md)). Only the adapter knows it.

`FillUserToContextMiddleware` runs on every update: `existsById`, then `edit` (with
`lastActiveTime = now`) or `create`, then `ctx.getUser()`. No transaction ties the check to the
action. Only `sequentialize()` protects them from a race, and only while nothing but private
chats reaches the pipeline ([invariant](./invariants.md)). `create()` does not guard against
duplicates itself: it relies on the upsert.

`UserService.edit()` reads the user with `getById` before `save`, because it has nothing to build
the entity from on the spot. The `User` constructor needs a whole `UserDto`, while `createdTime`
does not come in an update and has no setter.

The user lies in the context as a function, `ctx.getUser()`, not as a field. A clone of `User`
would be an empty object, since everything in the entity is in private fields
([invariant](./invariants.md)). The conversations plugin does not clone functions: it restores
them bound to the live context. So inside a conversation `getUser()` returns the user of the
current update, not a snapshot taken when the conversation was entered.

`ctx.from` is always filled here, by the construction of the pipeline: `HasSessionKeyFilter` has
already dropped the updates without a session key ([`bot.md`](./bot.md)). The `if (!ctx.from)`
check stays as an assertion. The compiler needs it, and it throws `UpdateWithoutFrom`
(`bot.errors.ts`) if the order in `Bot.setup()` is broken.

`RequestLogMiddleware` ([`bot.md`](./bot.md)) logs the whole `ctx.update` at `debug`. It also
increments `session.requestCount`, which nothing reads.
