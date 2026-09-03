#!/usr/bin/env sh
# Сброс базы: гасит общий Postgres и стирает каталог его кластера.
#
# Данные общие для всех рабочих деревьев: в дереве задачи tmp/pgsql — симлинк на
# основное дерево, поэтому цель, выглядящая локальной, стирает базу всех сессий
# сразу. Отсюда два предохранителя: подтверждение и отказ работать, пока подняты
# контейнеры приложения других деревьев.
set -eu

# Имя проекта базы и её сети зафиксированы в docker-compose.db.yml; здесь они нужны,
# чтобы отличить чужие контейнеры приложения от контейнера самой базы.
COMPOSE_FILE="docker-compose.db.yml"
DB_PROJECT="telegram-bot-db"
DB_NETWORK="telegram-bot-db_default"

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "не git-репозиторий: $PWD"
cd "$root"

data=$(cd tmp/pgsql 2>/dev/null && pwd -P || true)
if [ -z "$data" ]; then
    printf 'каталога tmp/pgsql нет, удалять нечего\n'
    exit 0
fi
# rm -rf по вычисленному пути — стоит убедиться, что вычислили именно каталог кластера.
[ "$(basename "$data")" = "pgsql" ] || die "tmp/pgsql ведёт в неожиданное место: $data"

# Postgres один на машину, и эта же цель его гасит, поэтому чужая сессия теряет базу
# прямо посреди работы: её контейнер уходит в перезапуск на упавших миграциях, а данные
# уже не вернуть. Поэтому отказ, а не предупреждение. Ищем по сети базы: в ней сидят
# приложения всех деревьев, а working_dir у контейнера — путь к его дереву.
others=$(
    docker ps --filter "network=$DB_NETWORK" \
        --format '{{.Label "com.docker.compose.project"}}	{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null |
        awk -F '\t' -v db="$DB_PROJECT" -v own="$root" '$1 != "" && $1 != db && $2 != own { print "  " $2 }' |
        sort -u
) || true

if [ -n "$others" ]; then
    printf 'подняты контейнеры приложения других рабочих деревьев:\n%s\n' "$others" >&2
    die "погасите их (make app-down в этих деревьях) и повторите"
fi

if [ "${CONFIRM:-}" != "1" ]; then
    [ -t 0 ] || die "неинтерактивный запуск: повторите как CONFIRM=1 make db-reset"
    printf 'Стереть данные базы в %s? Она общая для всех рабочих деревьев. [y/N] ' "$data"
    read -r answer
    case "$answer" in
        y | Y | yes | Yes | да | Да) ;;
        *) die "отменено" ;;
    esac
fi

docker compose -f "$COMPOSE_FILE" down

# Каталог удаляется целиком и создаётся заново, а не чистится изнутри: в дереве задачи
# tmp/pgsql — симлинк, и удаление идёт по разыменованному пути, сам симлинк остаётся.
rm -rf "$data"
mkdir -p "$data"
printf 'данные базы удалены: %s\n' "$data"
