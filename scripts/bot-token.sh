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
  add       дописать новый токен в конец пула и напечатать номер его слота;
            токен вводится в ответ на приглашение и не попадает ни в вывод,
            ни в аргументы процесса, ни в историю шелла

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
#
# Токен читается только со stdin: аргументом он был бы виден в таблице процессов любому
# пользователю машины и осел бы в истории шелла.
cmd_add() {
    [ "$#" -eq 0 ] || die "токен не передаётся аргументом — он уже попал в argv и виден в ps, а вызов остался в истории шелла; считайте этот токен скомпрометированным, отзовите его у @BotFather и добавьте новый: scripts/bot-token.sh add введёт токен с приглашения"

    # read возвращает ненулевой код и на строке без завершающего перевода строки, поэтому
    # её результат оставляем как есть, а не затираем.
    token=""
    if [ -t 0 ]; then
        printf 'токен от @BotFather (ввод не отображается): ' >&2
        stty_state=$(stty -g)
        # Без восстановления эха на любом выходе терминал остаётся без эха, и пользователю
        # приходится вслепую набирать stty sane. Ловим и EXIT: die внутри блока не сигнал.
        trap 'stty "$stty_state" 2>/dev/null || true' EXIT
        trap 'stty "$stty_state" 2>/dev/null || true; exit 130' HUP INT QUIT TERM
        stty -echo
        IFS= read -r token || true
        stty "$stty_state"
        # Снимаем до lock(): дальше свой обработчик EXIT ставит он.
        trap - EXIT HUP INT QUIT TERM
        printf '\n' >&2
    else
        IFS= read -r token || true
    fi

    # Срезаем только края: пробел внутри токена означает, что вставили не то, и об этом
    # лучше сказать, чем молча склеить строку.
    while :; do
        case "$token" in
            [[:space:]]*) token=${token#?} ;;
            *[[:space:]]) token=${token%?} ;;
            *) break ;;
        esac
    done

    [ -n "$token" ] || die "пустой ввод — в пул ничего не добавлено"
    case "$token" in
        *[[:space:]]*) die "в токене есть пробельные символы — он должен быть один и целиком" ;;
        \#*) die "токен не может начинаться с # — такая строка считается комментарием" ;;
    esac

    lock
    [ -f "$POOL_FILE" ] || : > "$POOL_FILE"
    chmod 600 "$POOL_FILE"
    # Закомментированная строка — тоже занятый токен: её раскомментируют, чтобы вернуть
    # токен в оборот, и тогда два слота с одним токеном дадут 409 Conflict. За `#` обычно
    # пишут ещё и причину вывода из оборота, поэтому токеном там считается только первое
    # поле. В активной строке токен — вся строка целиком: ровно её пишет в .env write_env.
    # Сам токен уходит в awk через окружение, а не аргументом: argv видно в ps.
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
            if (line != "" && line == candidate) {
                print NR, (commented ? "commented" : "active"), \
                    (!commented && raw != candidate ? "padded" : "clean")
                exit
            }
        }
    ' "$POOL_FILE")
    if [ -n "$dup" ]; then
        unlock
        line_no=${dup%% *}
        rest=${dup#* }
        case "$rest" in
            commented*)
                die "этот токен уже лежит в пуле закомментированным, строка $line_no — раскомментируйте её, чтобы вернуть токен в оборот; второй слот с тем же токеном даст 409 Conflict"
                ;;
            *padded)
                die "такой токен в пуле уже есть, слот $line_no — два процесса на один токен получают от Telegram 409 Conflict; заодно поправьте строку $line_no: краевые пробелы вокруг токена acquire запишет в .env как есть"
                ;;
            *)
                die "такой токен в пуле уже есть, слот $line_no — два процесса на один токен получают от Telegram 409 Conflict"
                ;;
        esac
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
        cmd_add "$@"
        ;;
    *) usage ;;
esac
