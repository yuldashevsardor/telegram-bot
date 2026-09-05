#!/usr/bin/env sh
# Уборка рабочего дерева задачи после влития PR — парная worktree-init.sh: гасит
# приложение этого дерева вместе с его образом и томом, удаляет само дерево, локальную
# ветку и ветку на origin.
#
# Момент уборки выбирает человек или агент, увидев, что PR влит: до влития дерево ещё
# нужно. Скрипт лишь убеждается, что убирать уже безопасно, и делает все четыре шага
# разом, чтобы не забылся ни один — забытый оставляет мусор, который потом читается
# наравне с работающей задачей.
set -eu

COMPOSE_FILE="docker-compose.app.yml"

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

main_tree() {
    common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "не git-репозиторий: $PWD"
    dirname "$common"
}

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "не git-репозиторий: $PWD"
main=$(main_tree)

[ "$root" != "$main" ] || die "это основное рабочее дерево — убирать нужно дерево задачи"

cd "$root"

branch=$(git branch --show-current) || die "не удалось определить ветку дерева $root"
[ -n "$branch" ] || die "дерево $root на detached HEAD — уберите его вручную, когда разберётесь с коммитами"

changes=$(git status --porcelain)
[ -z "$changes" ] || die "в дереве $root есть незакоммиченные изменения — уборка их уничтожит:
$changes"

# Слитость проверяется до всего остального: остальные шаги необратимы, а единственное,
# что здесь можно потерять, — коммиты ветки, которых нет в main.
git fetch --quiet origin main || die "не удалось получить origin/main — без него нельзя убедиться, что ветка $branch уже влита"
git merge-base --is-ancestor "$branch" origin/main || die "ветка $branch не влита в origin/main — дерево ещё нужно.
Если PR влит squash-мержем (коммитов ветки в main нет, есть только их результат), уберите дерево вручную:
    git worktree remove $root && git branch -D $branch && git push origin --delete $branch"

# Образ и том Compose именуются по каталогу дерева, и `git worktree remove` их не трогает:
# после удаления каталога до них уже не добраться этой целью — имя проекта брать неоткуда.
# Поэтому гасим до удаления и падаем, если не вышло, а не оставляем сироту молча.
docker compose -f "$COMPOSE_FILE" down --rmi local --volumes ||
    die "не удалось погасить приложение дерева $root — запустите Docker и повторите: после удаления каталога его образ этой целью уже не убрать"

cd "$main"

git worktree remove "$root"
git branch -d "$branch"

# Ветки на origin может уже не быть: GitHub умеет удалять её сам при влитии PR.
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    git push origin --delete "$branch"
    where="локально и на origin"
else
    where="локально; на origin её уже не было"
fi

printf 'убрано: дерево %s, ветка %s %s\n' "$root" "$branch" "$where"
printf 'текущий каталог сессии удалён — перейдите в основное дерево: cd %s\n' "$main"
