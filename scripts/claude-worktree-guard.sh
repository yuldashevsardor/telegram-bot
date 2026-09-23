#!/usr/bin/env sh
# Backs the CLAUDE.md rule "every task is done in its own git worktree".
# Called from the hooks in .claude/settings.json: session-start reminds of the rule,
# pre-edit denies an edit of a file that lies in the main worktree.
set -eu

physical() {
    ( cd "$1" 2>/dev/null && pwd -P )
}

# The directory of a file not yet on disk (Write of a new file) is taken as its nearest
# existing ancestor: git only answers about a path that exists.
existing_dir() {
    dir=$1
    while [ ! -d "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "." ]; do
        dir=$(dirname "$dir")
    done
    printf '%s' "$dir"
}

main_tree() {
    common=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
    physical "$(dirname "$common")"
}

# Prints the path of the main worktree if directory $1 lies in it and not in a task worktree.
in_main_tree() {
    root=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 1
    root=$(physical "$root")
    main=$(main_tree "$1") || return 1
    [ "$root" = "$main" ] || return 1
    printf '%s' "$main"
}

# Prints the .claude files that are newer on origin/main than in worktree $1. A session reads the
# text of a command or a skill from disk once — on first use — and never re-reads it, so a stale
# .claude feeds it an instruction main no longer has, and the session has no way to notice the
# swap: the agent does not open the file itself.
stale_claude() {
    git -C "$1" rev-parse --verify --quiet origin/main >/dev/null 2>&1 || return 1
    # Three dots, not two: the diff is taken from the fork point, so a .claude edit carried by
    # this worktree's own PR does not count as lagging. An uncommitted edit drops out along with
    # it — the trees of two commits are compared — and that is the same exception: both are made
    # here, and the check looks for lagging behind main, not for any difference from it.
    # For the same reason origin/main merged into the worktree turns the check off until main
    # moves ahead — even if the merge left .claude old (git merge -s ours): nothing lags here,
    # the branch chose the previous state itself.
    # There is no fetch of its own: a stale origin/main understates the lag but never invents
    # one, and going to the network on every session start costs more than a missed difference.
    # The path is written as :(top).claude: git resolves a plain pathspec from the current
    # directory, and a session is also started from a subdirectory of the worktree — then
    # .claude would not be found and the difference would silently go unnamed.
    files=$(git -C "$1" diff --name-only HEAD...origin/main -- ':(top).claude' 2>/dev/null) || return 1
    [ -n "$files" ] || return 1
    printf '%s' "$files" | tr '\n' ' '
}

case "${1:-}" in
    session-start)
        cwd=$(jq -r '.cwd // empty' 2>/dev/null) || cwd=""
        [ -n "$cwd" ] || cwd=$PWD
        dir=$(existing_dir "$cwd")
        notes=""
        if main=$(in_main_tree "$dir"); then
            # A detached HEAD shows as empty output, not as an exit code: git branch
            # --show-current succeeds in that state and prints an empty line.
            branch=$(git -C "$dir" branch --show-current 2>/dev/null) || branch=""
            [ -n "$branch" ] || branch="detached HEAD"
            notes=$(printf '%s' \
                "The session started in the main worktree $main (branch $branch). " \
                "By the CLAUDE.md rule a task is done in its own git worktree, and creating it " \
                "is the first step, before any edit: git worktree add \"$main/../telegram-bot-<task>\" " \
                "-b <branch> origin/main, then make worktree-init in it. " \
                "Edits of files in the main worktree are blocked by a hook.")
        fi
        stale=$(stale_claude "$dir") || stale=""
        if [ -n "$stale" ]; then
            stale_note=$(printf '%s' \
                "The .claude directory in this worktree lags behind origin/main, and these files differ: $stale. " \
                "The commands and skills of this session come from it, so the work will follow an instruction " \
                "main no longer has. Update the worktree (in the main one — git merge --ff-only " \
                "origin/main, in a task worktree — git merge origin/main) and restart the session: " \
                "text it has already read will not be refreshed.")
            if [ -n "$notes" ]; then
                notes=$(printf '%s\n\n%s' "$notes" "$stale_note")
            else
                notes=$stale_note
            fi
        fi
        [ -n "$notes" ] || exit 0
        jq -n --arg notes "$notes" '{
            hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: $notes
            }
        }'
        ;;
    pre-edit)
        file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null) || file=""
        [ -n "$file" ] || exit 0
        dir=$(existing_dir "$(dirname "$file")")
        main=$(in_main_tree "$dir") || exit 0
        jq -n --arg main "$main" --arg file "$file" '{
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: (
                    "\($file) lies in the main worktree \($main), where a neighbouring session may "
                    + "switch the branch at any moment. Create a task worktree and work in it: "
                    + "git worktree add \"\($main)/../telegram-bot-<task>\" -b <branch> origin/main, "
                    + "then make worktree-init in it."
                )
            }
        }'
        ;;
    *)
        printf 'usage: %s session-start|pre-edit\n' "$0" >&2
        exit 64
        ;;
esac
