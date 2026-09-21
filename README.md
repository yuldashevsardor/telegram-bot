# telegram-bot

A Telegram bot that converts font files between formats (`ttf`, `otf`, `woff`, `woff2`,
`eot`, `svg`). FontForge does the converting; users and sessions live in PostgreSQL.

How the code is laid out and what happens at runtime —
[`docs/architecture/`](docs/architecture/README.md), the terms — [`CONTEXT.md`](CONTEXT.md).

## Quick start

All you need is Docker with Compose v2: Node and FontForge are part of the image.

```bash
cp .env.dist .env   # put in the BOT_TOKEN from @BotFather
make up             # the database and this worktree's application
```

`make` with no arguments prints every target with its description. It is the only entry
point: plain `docker compose` and `npm` are not needed.

The environment is for development only: `./src` is mounted from the host, the bot runs
under `node --watch` and restarts on an edit. If the restarts stop (after a `git checkout`
the watcher can lose the file) — `make restart`. There is no production configuration in
the repository.

## The two compose files

| File                     | Project           | What it brings up                        |
| ------------------------ | ----------------- | ---------------------------------------- |
| `docker-compose.db.yml`  | `telegram-bot-db` | PostgreSQL, one per machine              |
| `docker-compose.app.yml` | directory name    | migrations and the bot; one per worktree |

The application finds the database by the service name `pgsql` in the external network
`telegram-bot-db_default`, so the database goes up first. Its data lies in `./tmp/pgsql`
of the main worktree.

## Working in several worktrees

Every task is done in its own worktree (the rule and the command that creates one are in
`CLAUDE.md`). Two things are shared between worktrees: the database and the token pool,
and both live in the main worktree.

### The token pool

Two bots long-polling with the same token get a `409 Conflict` from Telegram, so there are
as many tokens as there are bots running at once. The pool is the file `tmp/bot/tokens` in
the main worktree, one token per line.

`make token-status` names the worktree a slot is leased to; `make token-renew` extends the
lease, and the targets `up`, `app-up` and `restart` do that themselves.

- `make token-add` asks for the token at a prompt instead of taking it as an argument:
  arguments are visible in `ps` and stay in the shell history. The target rejects `token=…`.
- The slot number is the line number. New tokens are appended at the end, and the ones no
  longer needed are commented out with `#` (a note may follow: `# 111:aaa revoked
  2026-09-01`) rather than deleted: shifting the lines would scramble the leases already
  handed out.
- To put a token back into circulation, uncomment its line and drop the note: in an active
  line the token is the whole line.
- A lease belongs to a worktree path and expires after `BOT_TOKEN_TTL` (2 hours by default).
  `make token-release` frees the slot, and a deleted worktree frees it by itself.
- In the main worktree the token is written by hand, and one the pool does not know is left
  alone there. In a task worktree `.env` is a copy of the main one, so a token the pool does
  not know counts as inherited there: renewing the lease replaces it with a free slot.

### A task worktree

```bash
make worktree-init   # once
make app-up
```

After the PR is merged, in the task worktree:

```bash
make worktree-cleanup
```

The target refuses to clean up a worktree that has uncommitted changes or whose branch is
not merged into `main` on origin: everything past that point is irreversible. Otherwise it
takes the application down together with its image and volume, removes the worktree and the
branch both locally and on origin, and finally fast-forwards `main` in the main worktree —
a session starts there and reads the code and the docs from it until it creates a worktree
of its own. The directory disappears, so go back to the main worktree. A branch merged with
squash the target does not recognise as merged, and prints the commands to clean up by hand.

Removing the worktree can fail — it is held by `git worktree lock`, say, or something in it
will not delete (`coverage` and `reports` are mounted into the container, and on a Linux
host whatever is created there belongs to the container user). The target stops at that
step: with the worktree alive, removing its branch and fast-forwarding `main` would promise
a cleanup that did not happen. The output says that the application is already down together
with its image and volume, and then names one of two ways on: remove the cause and repeat
the target from that same worktree, or, once the worktree is unregistered and there is
nothing left to repeat the target from, finish the cleanup by hand with the commands it
prints.

Failing to remove the branch — locally, on origin, or failing to ask origin whether it is
still there — does not break off the cleanup: everything irreversible is done by then. The
target finishes its output, prints the hint for dealing with the branch by hand from the
main worktree, and exits non-zero; that is what tells these outcomes from a full cleanup,
and `make` prints its own error line on top. The worktree is gone by then, so there is
nothing to repeat the target from.

`main` can be left behind too: the main worktree is not on `main`, the fast-forward is
refused (own commits in `main`, uncommitted edits in the same files), or the `fetch` fails.
The target says `main` was not pulled and names the command to pull it by hand. The worktree
cleanup is done regardless, and the edits in the main worktree are untouched. The same
happens after a squash merge, where the target refuses at the merged-into-`main` check and
never gets that far.

How the target keeps `main` and `origin/main` fresh — with a ref of its own, fetched and
then copied rather than read from `origin/main` — is in the comments of
[`scripts/worktree-cleanup.sh`](scripts/worktree-cleanup.sh).

## Commands

The full list is `make`. What is worth knowing beyond the target descriptions:

- One-off targets — `build`, `typecheck`, the tests, the linters, the migrations — run in a
  throwaway container and work with the bot down, but the database has to be up: its network
  is needed by any application container, and the tests need the database itself
  ([`docs/architecture/testing.md`](docs/architecture/testing.md), "The test database"). The
  exceptions are `rebuild` (it builds the image, no database needed), `shell` and `psql` (they
  step into a running container).
- `make check` — types, eslint, prettier and the tests with the coverage threshold in one
  command.
- `files=` of `format-check` and `format` takes `.ts` only: `.prettierrc.js` hard-codes
  `parser: "typescript"`.
- `package.json`, `package-lock.json`, `.mocharc.json` and the linter configs are not
  mounted from the host (the list of volumes is in `docker-compose.app.yml`), so after they
  are edited the image goes stale silently — `make rebuild`.
- `make restart` recreates the container instead of restarting it: `docker compose restart`
  does not re-read `env_file`, and a changed `BOT_TOKEN` would never reach the bot.
- `make db-reset` refuses while application containers of other worktrees are running in the
  network of the database: the database is shared, and the reset would wipe it out from
  under them mid-work — take them down there with `make app-down` and repeat. A container of
  an already deleted worktree the target only names — remove it with `docker rm -f <name>`.
  `CONFIRM=1` answers the confirmation question in advance.

## The pre-commit hook

`.husky/pre-commit` runs `lint-staged` (`eslint --fix`, `prettier --write`) over the staged
files. It is a convenience of host development, not a mandatory gate: git runs the hook on
the host, where node is not always present.

- It turns itself on with `npm install` on the host — `package.json#prepare` calls husky,
  which creates `.husky/_` and sets `core.hooksPath`. There is no separate command for that.
- `core.hooksPath` lives in the shared config of the repository, one for every worktree, and
  git does not track `.husky/_`. So a fresh task worktree has no such directory and the hook
  silently does not run there until `npm install` is done in it.
- Working through Docker only, there is nothing to turn on: the image has `HUSKY=0` and
  `npm ci --ignore-scripts`, and `.git` is not mounted into the container. An installed hook
  skips itself in such an environment — as it does when node is not visible from git's hook
  environment (the usual reason is nvm: an interactive shell has node, the hook does not).
- Without the hook the checks are left to `make check` before a PR.

## Environment variables

Every variable lives in `.env` (the template is `.env.dist`), and only `BOT_TOKEN` is
mandatory. What the application reads is the table in `docs/architecture/config.md`.

- `DATABASE_HOST`/`DATABASE_PORT` from `.env` are only for connecting from the host: inside
  the compose network the address is set by `docker-compose.app.yml`, and `DATABASE_PORT` is
  the port the database publishes outwards for `psql`, DBeaver and the like.
- `BOT_TOKEN` in a task worktree is filled in by the pool and is not edited there by hand.
  In `.env.dist` it is always empty. A push with a real token is rejected by secret scanning
  on GitHub.
- `.runtime.env` is the only file the application re-reads on the fly: editing it rebuilds
  the configuration. Its values yield to environment variables, that is, what can be changed
  on the fly is what `.env` does not have or declares empty. The file is created by the
  `make` targets and by `scripts/worktree-init.sh`, and an empty one changes nothing. How
  editing this file differs inside the container, which way of saving never reaches it and
  what changes in a running application —
  [`docs/architecture/config.md`](docs/architecture/config.md), the sections on watching the
  file and on subscribing to changes.
