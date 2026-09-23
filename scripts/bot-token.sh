#!/usr/bin/env sh
# Leases a BOT_TOKEN from the shared pool: one token per worktree.
#
# The pool lives in tmp/bot of the main worktree — one per repository, whichever
# worktree the script is called from. Everything inside tmp/ is gitignored, and the
# token itself is never printed: only the slot number goes to the output.
set -eu

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

# All worktrees share one .git directory, and it lies in the main worktree; from a
# worktree the path to it is the only reliable way to find the main worktree.
main_tree() {
    common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "not a git repository: $PWD"
    dirname "$common"
}

POOL_DIR="${BOT_TOKEN_POOL_DIR:-$(main_tree)/tmp/bot}"
POOL_FILE="$POOL_DIR/tokens"
LEASE_DIR="$POOL_DIR/leases"
LOCK_DIR="$POOL_DIR/.lock"
TTL="${BOT_TOKEN_TTL:-7200}"

usage() {
    cat >&2 <<'USAGE'
Usage: scripts/bot-token.sh <acquire|renew|release|status|add>

  acquire   lease a free slot to the current worktree and write BOT_TOKEN
            into its .env; a repeated call from the same worktree returns
            the same slot
  renew     extend the lease of the current worktree (call it before starting
            the bot and before any long action); without a lease it does
            acquire, but in the main worktree it leaves alone a BOT_TOKEN the
            pool does not have even commented out: there it is written by hand.
            In a task worktree .env is always a copy of the main one, so a slot
            is always leased there
  release   free the slot of the current worktree
  status    show which slots are leased
  add       append a new token to the end of the pool and print its slot
            number; the token is typed at a prompt and ends up neither in the
            output, nor in the process arguments, nor in the shell history

Pool: tmp/bot/tokens of the main worktree, one token per line.
Variables: BOT_TOKEN_POOL_DIR (overrides where the pool lives),
           BOT_TOKEN_TTL in seconds (7200 by default).
USAGE
    exit 1
}

now() {
    date +%s
}

tree_root() {
    git rev-parse --show-toplevel 2>/dev/null || die "not a git repository: $PWD"
}

lock() {
    i=0
    while ! mkdir "$LOCK_DIR" 2>/dev/null; do
        i=$((i + 1))
        [ "$i" -gt 100 ] && die "lock $LOCK_DIR has been held for more than 10 seconds; if its process is dead, remove the directory"
        sleep 0.1
    done
    trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM
}

unlock() {
    rmdir "$LOCK_DIR" 2>/dev/null || true
    trap - EXIT INT TERM
}

field() {
    sed -n "s/^$2=//p" "$1" 2>/dev/null
}

# A lease is alive while its worktree exists and the TTL has not run out. The PID in
# the file is for reference only: an agent session has no long-lived process to judge
# its liveness by, so ownership is tied to the worktree.
lease_alive() {
    [ -f "$1" ] || return 1
    tree=$(field "$1" tree)
    ts=$(field "$1" ts)
    [ -n "$tree" ] && [ -d "$tree" ] || return 1
    case "$ts" in
        "" | *[!0-9]*) return 1 ;;
    esac
    [ "$(($(now) - ts))" -lt "$TTL" ]
}

slots() {
    [ -f "$POOL_FILE" ] || die "no pool file $POOL_FILE — put tokens from @BotFather into it, one per line"
    awk 'NF && $0 !~ /^[[:space:]]*#/ { print NR }' "$POOL_FILE"
}

find_mine() {
    for slot in $(slots); do
        file="$LEASE_DIR/$slot"
        if lease_alive "$file" && [ "$(field "$file" tree)" = "$1" ]; then
            printf '%s' "$slot"
            return 0
        fi
    done
}

write_lease() {
    printf 'tree=%s\nts=%s\npid=%s\n' "$2" "$(now)" "$$" > "$LEASE_DIR/$1"
}

# A whitespace-only value is the same empty BOT_TOKEN= from .env.dist, just with a stray
# space or a \r from a CRLF editor; taking it for a token written by hand would leave the
# worktree without a working token. Edge whitespace of the pool lines themselves is not
# affected: in_pool compares those by its own rules.
env_token() {
    env_file="$1/.env"
    [ -f "$env_file" ] || return 0
    value=$(field "$env_file" BOT_TOKEN | tail -n 1)
    while :; do
        case "$value" in
            [[:space:]]*) value=${value#?} ;;
            *[[:space:]]) value=${value%?} ;;
            *) break ;;
        esac
    done
    printf '%s' "$value"
}

# A token from a commented-out line counts as the pool's too: it is out of circulation but
# belongs to the pool, and a worktree holding it has to move to a free slot rather than stay
# on a revoked token. The line is parsed as in cmd_add: after `#` the token is the first field
# only, in an active line the token is the whole line, exactly what write_env writes to .env.
# The token goes to awk through the environment, not as an argument: argv is visible in ps.
in_pool() {
    [ -f "$POOL_FILE" ] || return 1
    BOT_TOKEN_CANDIDATE="$1" awk '
        BEGIN { candidate = ENVIRON["BOT_TOKEN_CANDIDATE"] }
        $0 == candidate { found = 1; exit }
        {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            if (line ~ /^#/) {
                sub(/^#+[[:space:]]*/, "", line)
                sub(/[[:space:]].*$/, "", line)
            } else {
                sub(/[[:space:]]+$/, "", line)
            }
            if (line != "" && line == candidate) { found = 1; exit }
        }
        END { exit !found }
    ' "$POOL_FILE"
}

write_env() {
    env_file="$1/.env"
    [ -f "$env_file" ] || die "no $env_file — copy it from the main worktree"
    tmp="$env_file.bot-token.$$"
    awk -v slot="$2" -v pool="$POOL_FILE" '
        BEGIN {
            while ((getline line < pool) > 0) {
                n++
                if (n == slot) token = line
            }
            if (token == "") exit 1
        }
        /^BOT_TOKEN=/ { print "BOT_TOKEN=" token; found = 1; next }
        { print }
        END { if (!found) print "BOT_TOKEN=" token }
    ' "$env_file" > "$tmp" || {
        rm -f "$tmp"
        die "slot $2 has no token — check $POOL_FILE"
    }
    mv "$tmp" "$env_file"
    chmod 600 "$env_file"
}

cmd_acquire() {
    root=$(tree_root)
    lock
    mine=$(find_mine "$root")
    if [ -z "$mine" ]; then
        for slot in $(slots); do
            if ! lease_alive "$LEASE_DIR/$slot"; then
                write_lease "$slot" "$root"
                mine="$slot"
                break
            fi
        done
    else
        write_lease "$mine" "$root"
    fi
    unlock
    [ -n "$mine" ] || die "no free slots; scripts/bot-token.sh status shows who holds them"
    write_env "$root" "$mine"
    printf 'slot %s leased to %s, BOT_TOKEN written to .env\n' "$mine" "$root"
}

cmd_renew() {
    root=$(tree_root)
    lock
    mine=$(find_mine "$root")
    [ -n "$mine" ] && write_lease "$mine" "$root"
    unlock
    if [ -n "$mine" ]; then
        printf 'slot %s renewed for another %s s\n' "$mine" "$TTL"
        return
    fi
    # No lease — either it expired or the worktree never worked with the pool. Leasing a
    # slot and rewriting .env is ruled out in exactly one case: the main worktree holds a
    # token the pool does not know. There it is written by hand — it belongs to a person, not
    # to the pool, and silently swapping it for the token of a free slot is not allowed.
    #
    # A task worktree gets .env as a copy of the main one (scripts/worktree-init.sh), so a
    # token the pool does not know is inherited there, not its own: leaving the worktree on it
    # means a second long polling on one token and a 409 Conflict, which the pool exists to
    # prevent.
    token=$(env_token "$root")
    if [ "$root" = "$(main_tree)" ] && [ -n "$token" ] && ! in_pool "$token"; then
        printf 'no slot is leased to %s; BOT_TOKEN in .env is not from the pool and is left as is\n' "$root" >&2
        return
    fi
    cmd_acquire
}

cmd_release() {
    root=$(tree_root)
    lock
    mine=$(find_mine "$root")
    [ -n "$mine" ] && rm -f "$LEASE_DIR/$mine"
    unlock
    if [ -z "$mine" ]; then
        printf 'no slot is leased to %s\n' "$root"
        return
    fi
    printf 'slot %s released\n' "$mine"
}

# The pool is append-only: a slot is a line number, so a token is always appended at the end.
# Inserting in the middle or deleting a line would shift the numbering, and live leases would
# start pointing at other tokens.
#
# The token is read from stdin only: as an argument it would be visible in the process table
# to every user of the machine and would settle in the shell history.
cmd_add() {
    [ "$#" -eq 0 ] || die "the token is not passed as an argument — it has already reached argv, visible in ps, and the call stays in the shell history; treat this token as compromised, revoke it at @BotFather and add a new one: scripts/bot-token.sh add asks for the token at a prompt"

    # read returns non-zero on a line without a trailing newline too, so what it read is
    # kept rather than wiped.
    token=""
    if [ -t 0 ]; then
        printf 'token from @BotFather (input is hidden): ' >&2
        stty_state=$(stty -g)
        # Unless echo is restored on every exit, the terminal stays without echo and the user
        # has to type stty sane blind. EXIT is trapped too: die inside the block is not a signal.
        trap 'stty "$stty_state" 2>/dev/null || true' EXIT
        trap 'stty "$stty_state" 2>/dev/null || true; exit 130' HUP INT QUIT TERM
        stty -echo
        IFS= read -r token || true
        stty "$stty_state"
        # Cleared before lock(): from there on it sets its own EXIT handler.
        trap - EXIT HUP INT QUIT TERM
        printf '\n' >&2
    else
        IFS= read -r token || true
    fi

    # Only the edges are trimmed: whitespace inside the token means the wrong thing was
    # pasted, and it is better to say so than to silently glue the line together.
    while :; do
        case "$token" in
            [[:space:]]*) token=${token#?} ;;
            *[[:space:]]) token=${token%?} ;;
            *) break ;;
        esac
    done

    [ -n "$token" ] || die "empty input — nothing added to the pool"
    case "$token" in
        *[[:space:]]*) die "the token contains whitespace — it must be a single token, whole" ;;
        \#*) die "a token cannot start with # — such a line counts as a comment" ;;
    esac

    lock
    [ -f "$POOL_FILE" ] || : > "$POOL_FILE"
    chmod 600 "$POOL_FILE"
    # A commented-out line is a taken token too: it gets uncommented to put the token back into
    # circulation, and then two slots with one token give a 409 Conflict. After `#` people
    # usually also write why the token was retired, so only the first field counts as the token
    # there. In an active line the token is the whole line: exactly what write_env writes to .env.
    # The token itself goes to awk through the environment, not as an argument: argv is visible
    # in ps.
    dup=$(BOT_TOKEN_CANDIDATE="$token" awk '
        BEGIN { candidate = ENVIRON["BOT_TOKEN_CANDIDATE"] }
        {
            raw = $0
            line = raw
            sub(/^[[:space:]]+/, "", line)
            commented = 0
            if (line ~ /^#/) {
                commented = 1
                sub(/^#+[[:space:]]*/, "", line)
                sub(/[[:space:]].*$/, "", line)
            } else {
                sub(/[[:space:]]+$/, "", line)
            }
            if (line == "" || line != candidate) next
            # add never creates a pool with an active and a commented-out copy of one token,
            # but a hand edit of the file easily does, and then the advice "uncomment it" would
            # give a second live slot. So an active match wins, whatever order the lines are in.
            if (!commented) {
                active = NR
                active_raw = raw
                exit
            }
            if (!commented_at) commented_at = NR
        }
        END {
            if (active) print active, "active", (active_raw == candidate ? "clean" : "padded")
            else if (commented_at) print commented_at, "commented", "clean"
        }
    ' "$POOL_FILE")
    if [ -n "$dup" ]; then
        unlock
        line_no=${dup%% *}
        rest=${dup#* }
        case "$rest" in
            commented*)
                die "this token is already in the pool, commented out, line $line_no — uncomment it to put the token back into circulation; a second slot with the same token would give a 409 Conflict"
                ;;
            *padded)
                die "this token is already in the pool, slot $line_no — two processes on one token get a 409 Conflict from Telegram; also fix line $line_no: acquire writes the whitespace around the token to .env as is"
                ;;
            *)
                die "this token is already in the pool, slot $line_no — two processes on one token get a 409 Conflict from Telegram"
                ;;
        esac
    fi
    # Without a trailing newline the appended token would be glued to the last line.
    if [ -s "$POOL_FILE" ] && [ "$(tail -c 1 "$POOL_FILE" | wc -l)" -eq 0 ]; then
        printf '\n' >> "$POOL_FILE"
    fi
    printf '%s\n' "$token" >> "$POOL_FILE"
    slot=$(awk 'END { print NR }' "$POOL_FILE")
    unlock

    printf 'token added to slot %s (%s)\n' "$slot" "$POOL_FILE"
}

cmd_status() {
    for slot in $(slots); do
        file="$LEASE_DIR/$slot"
        if lease_alive "$file"; then
            printf 'slot %s: leased to %s (renewed %s s ago)\n' \
                "$slot" "$(field "$file" tree)" "$(($(now) - $(field "$file" ts)))"
        else
            printf 'slot %s: free\n' "$slot"
        fi
    done
}

mkdir -p "$LEASE_DIR"
chmod 700 "$POOL_DIR" "$LEASE_DIR"

case "${1:-}" in
    acquire) cmd_acquire ;;
    renew) cmd_renew ;;
    release) cmd_release ;;
    status) cmd_status ;;
    add)
        shift
        cmd_add "$@"
        ;;
    *) usage ;;
esac
