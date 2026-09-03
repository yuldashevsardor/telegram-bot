#!/usr/bin/env sh
# Аренда BOT_TOKEN из общего пула: один токен на рабочее дерево.
#
# Пул лежит в tmp/bot основного рабочего дерева — один на репозиторий,
# независимо от того, из какого дерева вызван скрипт. Всё внутри tmp/ под
# gitignore, а сам токен нигде не печатается: в вывод идёт только номер слота.
set -eu

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

# Общий каталог .git у всех деревьев один и лежит в основном; из worktree путь
# к нему и есть единственный надёжный способ найти основное дерево.
main_tree() {
    common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "не git-репозиторий: $PWD"
    dirname "$common"
}

POOL_DIR="${BOT_TOKEN_POOL_DIR:-$(main_tree)/tmp/bot}"
POOL_FILE="$POOL_DIR/tokens"
LEASE_DIR="$POOL_DIR/leases"
LOCK_DIR="$POOL_DIR/.lock"
TTL="${BOT_TOKEN_TTL:-7200}"

usage() {
    cat >&2 <<'USAGE'
Использование: scripts/bot-token.sh <acquire|renew|release|status|add>

  acquire   занять свободный слот за текущим рабочим деревом и записать
            BOT_TOKEN в его .env; повторный вызов из того же дерева возвращает
            тот же слот
  renew     продлить аренду текущего дерева (вызывать перед запуском бота и
            вообще перед долгими действиями); без аренды делает acquire
  release   освободить слот текущего дерева
  status    показать занятость слотов
  add       дописать новый токен в конец пула и напечатать номер его слота
            (сам токен в вывод не попадает)

Пул: tmp/bot/tokens основного рабочего дерева, по токену на строку.
Переменные: BOT_TOKEN_POOL_DIR (переопределяет расположение пула),
            BOT_TOKEN_TTL в секундах (по умолчанию 7200).
USAGE
    exit 1
}

now() {
    date +%s
}

tree_root() {
    git rev-parse --show-toplevel 2>/dev/null || die "не git-репозиторий: $PWD"
}

lock() {
    i=0
    while ! mkdir "$LOCK_DIR" 2>/dev/null; do
        i=$((i + 1))
        [ "$i" -gt 100 ] && die "лок $LOCK_DIR не отпускают больше 10 секунд; если процесс мёртв — удалите каталог"
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

# Аренда жива, пока существует её рабочее дерево и не истёк TTL. PID в файле
# лежит справочно: у агентской сессии нет долгоживущего процесса, по которому
# можно было бы судить о её жизни, поэтому владение привязано к дереву.
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
    [ -f "$POOL_FILE" ] || die "нет файла пула $POOL_FILE — положите в него по одному токену от @BotFather на строку"
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

write_env() {
    env_file="$1/.env"
    [ -f "$env_file" ] || die "нет $env_file — скопируйте его из основного рабочего дерева"
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
        die "в слоте $2 нет токена — проверьте $POOL_FILE"
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
    [ -n "$mine" ] || die "свободных слотов нет; кто их занял — scripts/bot-token.sh status"
    write_env "$root" "$mine"
    printf 'слот %s закреплён за %s, BOT_TOKEN записан в .env\n' "$mine" "$root"
}

cmd_renew() {
    root=$(tree_root)
    lock
    mine=$(find_mine "$root")
    [ -n "$mine" ] && write_lease "$mine" "$root"
    unlock
    if [ -z "$mine" ]; then
        cmd_acquire
        return
    fi
    printf 'слот %s продлён ещё на %s с\n' "$mine" "$TTL"
}

cmd_release() {
    root=$(tree_root)
    lock
    mine=$(find_mine "$root")
    [ -n "$mine" ] && rm -f "$LEASE_DIR/$mine"
    unlock
    if [ -z "$mine" ]; then
        printf 'за %s слот не закреплён\n' "$root"
        return
    fi
    printf 'слот %s освобождён\n' "$mine"
}

# Пул append-only: слот — это номер строки, поэтому токен всегда дописывается в конец.
# Вставка в середину или удаление строки сдвинет нумерацию, и живые аренды начнут
# указывать на чужие токены.
cmd_add() {
    token="${1:-}"
    [ -n "$token" ] || die "укажите токен: scripts/bot-token.sh add <токен от @BotFather>"
    case "$token" in
        *[[:space:]]*) die "в токене есть пробельные символы — он должен быть один и целиком" ;;
        \#*) die "токен не может начинаться с # — такая строка считается комментарием" ;;
    esac

    lock
    [ -f "$POOL_FILE" ] || : > "$POOL_FILE"
    chmod 600 "$POOL_FILE"
    if awk -v t="$token" '$0 == t { found = 1 } END { exit !found }' "$POOL_FILE"; then
        unlock
        die "такой токен в пуле уже есть — два процесса на один токен получают от Telegram 409 Conflict"
    fi
    # Без завершающего перевода строки дописанный токен склеился бы с последней строкой.
    if [ -s "$POOL_FILE" ] && [ "$(tail -c 1 "$POOL_FILE" | wc -l)" -eq 0 ]; then
        printf '\n' >> "$POOL_FILE"
    fi
    printf '%s\n' "$token" >> "$POOL_FILE"
    slot=$(awk 'END { print NR }' "$POOL_FILE")
    unlock

    printf 'токен добавлен в слот %s (%s)\n' "$slot" "$POOL_FILE"
}

cmd_status() {
    for slot in $(slots); do
        file="$LEASE_DIR/$slot"
        if lease_alive "$file"; then
            printf 'слот %s: занят %s (обновлён %s с назад)\n' \
                "$slot" "$(field "$file" tree)" "$(($(now) - $(field "$file" ts)))"
        else
            printf 'слот %s: свободен\n' "$slot"
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
        cmd_add "${1:-}"
        ;;
    *) usage ;;
esac
