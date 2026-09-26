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

The environment is for development only; there is no production configuration in the
repository. `./src` is mounted from the host, and the bot runs under `node --watch`,
restarting on every edit. If the restarts stop — after a `git checkout` the watcher can lose
the file — run `make restart`.

## The two compose files

| File                     | Project           | What it brings up                        |
| ------------------------ | ----------------- | ---------------------------------------- |
| `docker-compose.db.yml`  | `telegram-bot-db` | PostgreSQL, one per machine              |
| `docker-compose.app.yml` | directory name    | migrations and the bot; one per worktree |

The database goes up first: the application finds it by the service name `pgsql` in the
external network `telegram-bot-db_default`. Its data lies in `./tmp/pgsql` of the main
worktree.

## Working in several worktrees

Every task is done in its own worktree (the rule and the command that creates one are in
`CLAUDE.md`). Two things are shared between worktrees: the database and the token pool,
and both live in the main worktree.

### The token pool

The pool needs as many tokens as there are bots running at once: two bots long-polling
with the same token get a `409 Conflict` from Telegram. The pool is the file
`tmp/bot/tokens` in the main worktree, one token per line.

`make token-status` names the worktree a slot is leased to. `make token-renew` extends the
lease; the targets `up`, `app-up` and `restart` renew it themselves.

- `make token-add` asks for the token at a prompt and rejects `token=…`: arguments are
  visible in `ps` and stay in the shell history.
- The slot number is the line number. So new tokens are appended at the end, and a token no
  longer needed is commented out with `#` rather than deleted: shifting the lines would
  scramble the leases already handed out. A note may follow the token: `# 111:aaa revoked
  2026-09-01`.
- To put a token back into circulation, uncomment its line and drop the note: in an active
  line the whole line is the token.
- A lease belongs to a worktree path and expires after `BOT_TOKEN_TTL` (2 hours by default).
  `make token-release` frees the slot; deleting the worktree frees it too.
- In the main worktree the token is written by hand, and a token the pool does not know is
  left alone there. In a task worktree `.env` is a copy of the main one, so an unknown token
  there is inherited: renewing the lease replaces it with a free slot.

### A task worktree

```bash
make worktree-init   # once
make app-up
```

After the PR is merged, in the task worktree:

```bash
make worktree-cleanup
```

The target refuses while the worktree has uncommitted changes or its branch is not merged
into `main` on origin: every step after this check is irreversible. Then it:

1. takes the application down together with its image and volume;
2. removes the worktree;
3. deletes the branch locally and on origin;
4. fast-forwards `main` in the main worktree: a session starts there and reads the code and
   the docs from it until it creates a worktree of its own.

The directory disappears, so go back to the main worktree. A branch merged with squash the
target does not recognise as merged: it refuses and prints the commands to clean up by hand.

**Removing the worktree fails** — it is held by `git worktree lock`, say, or something in it
will not delete. `coverage` and `reports` are mounted into the container, and on a Linux host
whatever is created there belongs to the container user. The target stops at this step: with
the worktree alive, deleting its branch and fast-forwarding `main` would promise a cleanup
that did not happen. The output says that the application is already down together with its
image and volume, and names one of two ways on:

- the worktree is still there: remove the cause and repeat the target from it;
- the worktree is already unregistered, so there is nothing to repeat the target from:
  finish the cleanup by hand with the commands it prints.

**Deleting the branch fails** — locally, on origin, or origin cannot be asked whether the
branch is still there. This does not break off the cleanup: everything irreversible is done
by then. The target finishes its output, prints the hint for dealing with the branch by hand
from the main worktree, and exits non-zero. The non-zero code is what tells these outcomes
from a full cleanup; `make` prints its own error line on top. The worktree is gone by then,
so there is nothing to repeat the target from.

**`main` is left behind** when the main worktree is not on `main`, the fast-forward is
refused (own commits in `main`, uncommitted edits in the same files), or the `fetch` fails.
The target says `main` was not fast-forwarded and names the command to do it by hand. The
worktree cleanup is done regardless, and the edits in the main worktree are untouched. After
a squash merge `main` is left behind too: the target refuses at the merged check and never
gets that far.

The target keeps `main` and `origin/main` fresh through a ref of its own: it fetches that ref
and copies it into `origin/main` rather than reading `origin/main`. Why — in the comments of
[`scripts/worktree-cleanup.sh`](scripts/worktree-cleanup.sh).

## Commands

The full list is `make`. What is worth knowing beyond the target descriptions:

- One-off targets — `build`, `typecheck`, the tests, the linters, the migrations — run in a
  throwaway container. They work with the bot down but need the database up: any application
  container needs its network, and the tests need the database itself
  ([`docs/architecture/testing.md`](docs/architecture/testing.md), "The test database").
  The exceptions: `rebuild` builds the image and needs no database; `shell` and `psql` step
  into a running container.
- `make check` — types, eslint, prettier and the tests with the coverage threshold in one
  command.
- `files=` of `format-check` and `format` takes `.ts` only: `.prettierrc.js` hard-codes
  `parser: "typescript"`.
- After an edit to `package.json`, `package-lock.json`, `.mocharc.json` or a linter config,
  run `make rebuild`. These files are not mounted from the host (the list of volumes is in
  `docker-compose.app.yml`), and the image goes stale silently.
- `make restart` recreates the container instead of restarting it: `docker compose restart`
  does not re-read `env_file`, and a changed `BOT_TOKEN` would never reach the bot.
- `make db-reset` refuses while application containers of other worktrees run in the network
  of the database. The database is shared, and the reset would wipe it out from under them
  mid-work: take them down there with `make app-down` and repeat. A container of an already
  deleted worktree the target only names; remove it with `docker rm -f <name>`.
  `CONFIRM=1` answers the confirmation question in advance.

## The pre-commit hook

`.husky/pre-commit` runs `lint-staged` (`eslint --fix`, `prettier --write`) over the staged
files. It is a convenience of host development, not a mandatory gate: git runs the hook on
the host, where node is not always present. Without the hook the checks are left to
`make check` before a PR.

- `npm install` on the host turns the hook on: `package.json#prepare` calls husky, which
  creates `.husky/_` and sets `core.hooksPath`. There is no separate command for that.
- A fresh task worktree silently runs no hook until `npm install` is done in it.
  `core.hooksPath` lives in the repository config shared by every worktree, but git does not
  track `.husky/_`, so a new worktree has no such directory.
- Working through Docker only, there is nothing to turn on: the image has `HUSKY=0` and
  `npm ci --ignore-scripts`, and `.git` is not mounted into the container.
- An installed hook skips itself where node is not visible from git's hook environment: on a
  host without node, or with nvm, which an interactive shell initialises and the hook
  environment does not.

## Environment variables

Every variable lives in `.env` (the template is `.env.dist`), and only `BOT_TOKEN` is
mandatory. What each variable does and which values it takes is in the comments of `.env.dist`.

- `DATABASE_HOST`/`DATABASE_PORT` from `.env` are only for connecting from the host. Inside
  the compose network the address is set by `docker-compose.app.yml`. `DATABASE_PORT` is the
  port the database publishes outwards, for `psql`, DBeaver and the like.
- `BOT_TOKEN` in a task worktree is filled in by the pool; do not edit it there by hand. In
  `.env.dist` it is always empty. A push with a real token is rejected by secret scanning on
  GitHub.
- `.runtime.env` is the only file the application re-reads on the fly: editing it rebuilds
  the configuration. Its values yield to environment variables, so only what `.env` lacks or
  declares empty can change on the fly. The `make` targets and `scripts/worktree-init.sh`
  create the file, and an empty one changes nothing. How editing the file differs inside the
  container, which way of saving never reaches it, and what changes in a running application —
  [`docs/architecture/config.md`](docs/architecture/config.md), "Watching the file" and
  "Change subscriptions".
