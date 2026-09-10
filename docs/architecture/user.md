# User

`domain/user/`: сущность `User` с приватными полями и сеттерами, которые проставляют
`updatedTime`; порт `UserRepository`; `UserService.create()`/`edit()` с обёрткой ошибок
в `UserCreateError`/`UserEditError`. `PgSqlUserRepository.save()` — upsert
`on conflict (id) do update`.

`FillUserToContextMiddleware` на каждом апдейте: `existsById` → `edit` (с
`lastActiveTime = now`) или `create` → `ctx.getUser()`. Проверка и действие не связаны
транзакцией; от гонки защищает только `sequentialize()` по `from.id`
([`bot.md`](./bot.md)). `create()` не защищает от дублей сам — полагается на upsert.

Пользователь лежит в контексте функцией `ctx.getUser()`, а не полем: клон `User` был бы
пустым объектом — у сущности всё в приватных полях ([инвариант](./invariants.md)). Функции
плагин разговоров не клонирует, а восстанавливает биндом от живого контекста, поэтому
внутри разговора `getUser()` отдаёт пользователя текущего апдейта, а не слепок с момента
входа в разговор.

`ctx.from` здесь заполнен по построению пайплайна: апдейты без ключа сессии отбросил
`HasSessionKeyFilter` ([`bot.md`](./bot.md)). Проверка `if (!ctx.from)` осталась как
ассерт — она нужна компилятору и бросает `UpdateWithoutFrom` (`bot.errors.ts`), если
порядок в `Bot.setup()` сломают. `RequestLogMiddleware` ([`bot.md`](./bot.md)) логирует
весь `ctx.update` на `debug` и инкрементирует `session.requestCount`, который нигде не
читается.
