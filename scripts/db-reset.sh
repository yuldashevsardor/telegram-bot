#!/usr/bin/env sh
# Resets the database: takes the shared Postgres down and wipes the directory it will
# start from next time.
#
# The data is shared by all worktrees: in a task worktree tmp/pgsql is a symlink to the
# main worktree, so this local-looking target wipes the database of every session. Hence
# two safeguards: a confirmation, and a refusal while application containers of other
# worktrees are running.
set -eu

# Both names are fixed in docker-compose.db.yml. They tell the application containers of
# other worktrees from the database's own.
COMPOSE_FILE="docker-compose.db.yml"
DB_PROJECT="telegram-bot-db"
DB_NETWORK="telegram-bot-db_default"
TAB=$(printf '\t')

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

# Resolves symlinks in a path. Compose writes the logical $PWD into the label, while
# git rev-parse --show-toplevel resolves symlinks: without this a worktree reached through
# a symlink would take its own container for another's.
real_path() {
    (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"
}

# Finds application containers by the database network: the applications of all worktrees
# sit in it, both running bots and the throwaway containers of one-off targets
# (make migrate/build/test).
# Prints a line per container: <state> <TAB> <name> <TAB> <worktree>.
# The check is best-effort: a container that has used up restart: on-failure drops out of
# docker ps, although the session in its worktree is at work.
app_containers() {
    # docker ps is checked on its own, not piped into the loop: a pipeline exits with the code
    # of its last command. This is the only guard against irreversible data loss, and a docker
    # failure must not read as "no other worktrees".
    listing=$(docker ps --filter "network=$DB_NETWORK" \
        --format "{{.Label \"com.docker.compose.project\"}}$TAB{{.Label \"com.docker.compose.project.working_dir\"}}$TAB{{.Names}}") ||
        die "could not query docker: there is no way to make sure other worktrees are not running"

    # Fields are cut by hand, not with IFS="$TAB" read: for read a tab is whitespace, so
    # consecutive tabs collapse into one, and a line with an empty label shifts left.
    printf '%s\n' "$listing" | while IFS= read -r line; do
        project=${line%%"$TAB"*}
        rest=${line#*"$TAB"}
        dir=${rest%%"$TAB"*}
        name=${rest#*"$TAB"}

        [ -n "$project" ] && [ "$project" != "$DB_PROJECT" ] || continue

        # A container whose directory is not on disk is garbage, not a working session: git
        # worktree remove does not take the container down. It must not block the target, or
        # the target stays blocked for good.
        # A container with no worktree given counts as another's: the only guard against
        # irreversible data loss must err on the side of refusing.
        if [ -z "$dir" ]; then
            printf 'alien%s%s%s%s\n' "$TAB" "$name" "$TAB" "worktree not given"
        elif [ ! -d "$dir" ]; then
            printf 'stale%s%s%s%s\n' "$TAB" "$name" "$TAB" "$dir"
        elif [ "$(real_path "$dir")" = "$root" ]; then
            printf 'own%s%s%s%s\n' "$TAB" "$name" "$TAB" "$dir"
        else
            printf 'alien%s%s%s%s\n' "$TAB" "$name" "$TAB" "$dir"
        fi
    done
}

# Other worktrees get a refusal, not a warning. There is one Postgres per machine, and this
# target takes it down, so another session loses the database mid-work: its container goes
# into restarts on failed migrations, and the data is gone for good.
check_containers() {
    rows=$(app_containers) || exit 1
    alien=$(printf '%s\n' "$rows" | awk -F "$TAB" '$1 == "alien" { print "  " $3 "  (container " $2 ")" }')

    if [ "$1" = "verbose" ]; then
        stale=$(printf '%s\n' "$rows" | awk -F "$TAB" '$1 == "stale" { print "  " $2 "  (worktree " $3 " is not on disk)" }')
        [ -z "$stale" ] ||
            printf 'containers of removed worktrees — the target ignores them, remove them with docker rm -f <name>:\n%s\n' "$stale" >&2

        mine=$(printf '%s\n' "$rows" | awk -F "$TAB" '$1 == "own" { print "  " $2 }')
        [ -z "$mine" ] ||
            printf 'an application container of this worktree is running — after the reset it loses the database and dies on failed migrations:\n%s\n' "$mine" >&2
    fi

    [ -n "$alien" ] || return 0
    printf 'application containers of other worktrees are running:\n%s\n' "$alien" >&2
    die "take them down (make app-down in those worktrees or docker rm -f <name>) or wait for the one-off command to finish, and repeat"
}

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not a git repository: $PWD"
root=$(real_path "$root")
cd "$root"

data=$(cd tmp/pgsql 2>/dev/null && pwd -P || true)
if [ -z "$data" ]; then
    printf 'no tmp/pgsql directory — nothing to wipe, the database is untouched\n'
    exit 0
fi
# rm -rf on a computed path: make sure it is a directory with the expected name, not
# wherever a broken symlink led.
# A running container may use another cluster directory: its bind was frozen by the worktree
# db-up ran from. But down recreates the container with this path, so the next start is
# from it.
[ "$(basename "$data")" = "pgsql" ] || die "tmp/pgsql leads to an unexpected place: $data"

check_containers verbose

if [ "${CONFIRM:-}" != "1" ]; then
    [ -t 0 ] || die "non-interactive run: repeat as CONFIRM=1 make db-reset"
    # The question goes to stderr: the tty is checked on stdin, and with make db-reset > out.txt
    # a question on stdout would go to the file while the terminal looks hung.
    printf 'Wipe the database data in %s? It is shared by all worktrees. [y/N] ' "$data" >&2
    # Ctrl-D is as deliberate a cancel as "no", and it must end the same way.
    read -r answer || answer=""
    case "$answer" in
        y | Y | yes | Yes) ;;
        *)
            printf 'cancelled\n'
            exit 0
            ;;
    esac
    # The check is repeated: the pause at the question is unbounded, and meanwhile a
    # neighbouring worktree may have brought up a bot or started a one-off target.
    check_containers quiet
fi

docker compose -f "$COMPOSE_FILE" down

# Removed whole and created anew rather than emptied from inside: $data is the dereferenced
# path, so in a task worktree the tmp/pgsql symlink itself stays.
rm -rf "$data"
mkdir -p "$data"
printf 'database data removed: %s\n' "$data"
