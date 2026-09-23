#!/usr/bin/env sh
# Prepares a task worktree: the directories shared with the main worktree, its own .env
# and its own BOT_TOKEN from the pool. Run once after the worktree is created.
set -eu

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

main_tree() {
    common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "not a git repository: $PWD"
    dirname "$common"
}

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not a git repository: $PWD"
main=$(main_tree)

[ "$root" != "$main" ] || die "this is the main worktree — the script is only for a task worktree"

cd "$root"

# There is one database per machine, so its directory is shared: in a task worktree tmp/pgsql
# is a symlink to the main worktree, and docker-compose.db.yml lands in the same cluster
# whichever worktree brings it up. The rest of tmp/ is each worktree's own.
mkdir -p "$main/tmp/pgsql"
if [ -e tmp/pgsql ] && [ ! -L tmp/pgsql ]; then
    die "tmp/pgsql here is a plain directory; remove it if it holds no data you need, and repeat"
fi
ln -sfn "$main/tmp/pgsql" tmp/pgsql

if [ ! -f .env ]; then
    [ -f "$main/.env" ] || die "no $main/.env — create it from .env.dist in the main worktree"
    cp "$main/.env" .env
    chmod 600 .env
fi

# The hot configuration file is each worktree's own and starts empty: its values are what gets
# edited on the fly, not what is inherited from the main worktree. It is created here for the same
# reason the make targets create it — see the comment at DC_APP in the Makefile. Its permissions
# are not narrowed to 600 as with .env: the file is mounted into the container and read there as
# USER node, and on a Linux host that uid does not match the owner's — the application would fail
# reading its own empty file. Nor are secrets kept in it: a set environment variable wins over it
# anyway (docs/architecture/invariants.md).
if [ ! -f .runtime.env ]; then
    touch .runtime.env
fi

scripts/bot-token.sh acquire

printf 'worktree %s is ready: tmp/pgsql shared, .env and .runtime.env its own\n' "$root"
