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

# Печатает файлы .claude, которые на origin/main новее, чем в дереве $1. Текст команды и
# скилла сессия читает с диска один раз — при первом обращении к файлу — и дальше не
# перечитывает, поэтому отставший .claude подаёт ей инструкцию, которой на main уже нет,
# а заметить подмену ей нечем: сам файл агент не открывает.
stale_claude() {
    git -C "$1" rev-parse --verify --quiet origin/main >/dev/null 2>&1 || return 1
    # Три точки, а не две: диф считается от точки ветвления, поэтому правка .claude, которую
    # ведёт сам PR этого дерева, за отставание не принимается. Своего fetch тут нет: по
    # несвежему origin/main отставание занижается, но не выдумывается, а ходить в сеть на
    # каждом старте сессии дороже пропущенного расхождения.
    # Путь пишется как :(top).claude: обычный pathspec git считает от текущего каталога, а
    # сессию запускают и из подкаталога дерева — тогда .claude не нашёлся бы и расхождение
    # молча осталось бы неназванным.
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
            branch=$(git -C "$dir" branch --show-current 2>/dev/null || printf 'detached HEAD')
            notes=$(printf '%s' \
                "Сессия запущена в основном рабочем дереве $main (ветка $branch). " \
                "По правилу CLAUDE.md задача ведётся в своём git worktree, и создать его нужно " \
                "первым шагом, до любых правок: git worktree add \"$main/../telegram-bot-<задача>\" " \
                "-b <ветка> origin/main, затем в нём make worktree-init. " \
                "Правки файлов в основном дереве блокируются хуком.")
        fi
        stale=$(stale_claude "$dir") || stale=""
        if [ -n "$stale" ]; then
            stale_note=$(printf '%s' \
                "Каталог .claude в этом дереве отстаёт от origin/main, и расходятся файлы: $stale. " \
                "Команды и скиллы этой сессии поданы из него, то есть работа пойдёт по инструкции, " \
                "которой на main уже нет. Подтяни дерево (в основном — git merge --ff-only " \
                "origin/main, в дереве задачи — git merge origin/main) и перезапусти сессию: " \
                "прочитанный текст в ней уже не обновится.")
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
                    "\($file) лежит в основном рабочем дереве \($main), где соседняя сессия в любой "
                    + "момент переключает ветку. Заведи дерево задачи и работай в нём: "
                    + "git worktree add \"\($main)/../telegram-bot-<задача>\" -b <ветка> origin/main, "
                    + "затем в нём make worktree-init."
                )
            }
        }'
        ;;
    *)
        printf 'использование: %s session-start|pre-edit\n' "$0" >&2
        exit 64
        ;;
esac
