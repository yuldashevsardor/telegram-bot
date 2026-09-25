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

# There is one database per machine, so its directory is shared. In a task worktree tmp/pgsql
# is a symlink to the main worktree, and docker-compose.db.yml starts the same cluster from
# any worktree. The rest of tmp/ is each worktree's own.
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

# The hot configuration file is each worktree's own and starts empty: it holds values edited on
# the fly, not ones inherited from the main worktree. It is created here for the reason the make
# targets create it: see the comment at DC_APP in the Makefile.
# It is not narrowed to 600 like .env. The container mounts it and reads it as USER node, a uid
# that on a Linux host is not the owner's, so the application would fail reading its own empty
# file. Nor does it hold secrets: a set environment variable wins over it anyway
# (docs/architecture/invariants.md).
if [ ! -f .runtime.env ]; then
    touch .runtime.env
fi

scripts/bot-token.sh acquire

printf 'worktree %s is ready: tmp/pgsql shared, .env and .runtime.env its own\n' "$root"
