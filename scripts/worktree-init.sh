#!/usr/bin/env sh
# Подготовка рабочего дерева задачи: общие с основным деревом каталоги, свой .env
# и свой BOT_TOKEN из пула. Запускается один раз после создания дерева.
set -eu

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

[ "$root" != "$main" ] || die "это основное рабочее дерево — скрипт нужен только в дереве задачи"

cd "$root"

# База данных одна на машину, поэтому её каталог общий: в дереве задачи tmp/pgsql —
# симлинк на основное дерево, и docker-compose.db.yml попадает в тот же кластер,
# из какого бы дерева его ни подняли. Остальное в tmp/ у каждого дерева своё.
mkdir -p "$main/tmp/pgsql"
if [ -e tmp/pgsql ] && [ ! -L tmp/pgsql ]; then
    die "tmp/pgsql здесь — обычный каталог; удалите его, если в нём нет нужных данных, и повторите"
fi
ln -sfn "$main/tmp/pgsql" tmp/pgsql

if [ ! -f .env ]; then
    [ -f "$main/.env" ] || die "нет $main/.env — создайте его из .env.dist в основном дереве"
    cp "$main/.env" .env
    chmod 600 .env
fi

scripts/bot-token.sh acquire

printf 'дерево %s готово: tmp/pgsql общий, .env свой\n' "$root"
