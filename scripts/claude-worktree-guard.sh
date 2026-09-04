#!/usr/bin/env sh
# Подкрепляет правило CLAUDE.md «каждая задача — в своём git worktree».
# Вызывается из хуков .claude/settings.json: session-start напоминает о правиле,
# pre-edit отказывает в правке файла, лежащего в основном рабочем дереве.
set -eu

physical() {
    ( cd "$1" 2>/dev/null && pwd -P )
}

# Каталог файла, которого ещё нет на диске (Write нового файла), берётся ближайшим
# существующим предком: git отвечает только про существующий путь.
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

# Печатает путь основного дерева, если каталог $1 лежит именно в нём.
in_main_tree() {
    root=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 1
    root=$(physical "$root")
    main=$(main_tree "$1") || return 1
    [ "$root" = "$main" ] || return 1
    printf '%s' "$main"
}

case "${1:-}" in
    session-start)
        cwd=$(jq -r '.cwd // empty' 2>/dev/null) || cwd=""
        [ -n "$cwd" ] || cwd=$PWD
        dir=$(existing_dir "$cwd")
        main=$(in_main_tree "$dir") || exit 0
        branch=$(git -C "$dir" branch --show-current 2>/dev/null || printf 'detached HEAD')
        jq -n --arg main "$main" --arg branch "$branch" '{
            hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: (
                    "Сессия запущена в основном рабочем дереве \($main) (ветка \($branch)). "
                    + "По правилу CLAUDE.md задача ведётся в своём git worktree, и создать его нужно "
                    + "первым шагом, до любых правок: git worktree add \"\($main)/../telegram-bot-<задача>\" "
                    + "-b <ветка> origin/main. Правки файлов в основном дереве блокируются хуком."
                )
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
                    "\($file) лежит в основном рабочем дереве \($main), где соседняя сессия в любой "
                    + "момент переключает ветку. Заведи дерево задачи и работай в нём: "
                    + "git worktree add \"\($main)/../telegram-bot-<задача>\" -b <ветка> origin/main."
                )
            }
        }'
        ;;
    *)
        printf 'использование: %s session-start|pre-edit\n' "$0" >&2
        exit 64
        ;;
esac
