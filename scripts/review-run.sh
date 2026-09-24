#!/usr/bin/env sh
# The mechanical run of a PR review — steps 1–2 and the cleanup of
# .claude/skills/pr-light-check/SKILL.md in one call. The gates passed in run over the head of the
# PR in a temporary tree, and what comes out is the "Checks" lines of the verdict, the part of a log
# that explains a red gate, and the material the reviewer reads itself. Which gates are on is decided
# by /review-pr (docs/agents/review-gates.md), not here.
#
#   make review-run pr=<N> gates="<gates>" [targets="<make targets>"] [flags="<flags>"] [record=refuse]
#
# targets= names the targets whose make -n expansion the make-targets gate prints: which targets a
# diff changed is the reviewer's reading. flags= are the flags of the review as they came; only
# --no-post means anything here. record=refuse makes a mutation gate run its target instead of
# accepting a record — the reviewer's answer when a record accepted on a condition does not hold
# (accept_record below).
#
# The script is taken from the tree the review started in, not from the PR: a PR that edits it, the
# area rule or the acceptance of a record is not checked by its own version of them. The gates
# themselves run the targets of the PR's Makefile — those are what the run checks.
#
# No set -e: a red gate is an outcome to report, not an error to stop at, so the code of every
# command is checked where it matters.
set -u

COMPOSE_FILE="docker-compose.app.yml"
SIGNATURE="_🤖 Posted by Claude Code from the owner's account._"
# A source of dash: the scripts are declared #!/usr/bin/env sh, but /bin/sh of macOS is bash in
# POSIX mode and lets through bashisms that fail on dash in Linux. The Node version has nothing to do
# with it.
DASH_IMAGE="node:24-bookworm-slim"
ESC=$(printf '\033')

usage() {
    printf 'usage: make review-run pr=<N> gates="<gates>" [targets="<make targets>"] [flags="--no-post"] [record=refuse]\n' >&2
    exit 64
}

pr=${1:-}
gates=${2:-}
targets=${3:-}
flags=${4:-}
record_mode=${5:-}

case $pr in
    '' | *[!0-9]*) usage ;;
esac
[ -n "$gates" ] || usage
case $record_mode in
    '' | refuse) ;;
    *) usage ;;
esac
no_post=""
for flag in $flags; do
    case $flag in
        --no-post) no_post=1 ;;
        --comment) ;;
        *) usage ;;
    esac
done
# A target goes into make -n as an argument, and anything but a name would be an option of make.
for target in $targets; do
    case $target in
        -* | *[!A-Za-z0-9_.-]*) usage ;;
    esac
done

# The allowlist: only these gates run, each only its command below. A new Makefile target counts as
# dangerous until it is written in here, so an unknown gate is reported rather than guessed at. Left
# out on purpose, although they look fitting in a review:
# - lint-fix and format edit the files of the PR: the run would check something other than what was
#   sent, and the red of lint and format-check would disappear together with the finding;
# - test-watch does not finish but waits for changes, and the run would hang;
# - test runs the specs of coverage without its threshold (docs/architecture/testing.md,
#   "Coverage"): a PR that dropped coverage would pass while make check fails for the author. So the
#   test gate runs make coverage and loses nothing: nyc runs the same mocha, a failed spec is printed
#   the same way, and the run fails at 100% coverage too;
# - check runs typecheck, lint, format:check and test:coverage in one output, while the verdict needs
#   a line per gate.
on_rebuild="" on_build="" on_typecheck="" on_test="" on_lint="" on_format="" on_targets=""
on_scripts="" on_mutation="" on_full=""
unknown=""
for gate in $gates; do
    case $gate in
        rebuild) on_rebuild=1 ;;
        build) on_build=1 ;;
        typecheck) on_typecheck=1 ;;
        test) on_test=1 ;;
        lint) on_lint=1 ;;
        format-check) on_format=1 ;;
        make-targets) on_targets=1 ;;
        scripts) on_scripts=1 ;;
        mutation) on_mutation=1 ;;
        mutation-full) on_full=1 ;;
        # The gates of the reviewer's own reading: none of them runs a command.
        docs | docs-sync | bug-hunt-high | bug-hunt-medium | smells) ;;
        *) unknown="$unknown $gate" ;;
    esac
done
# The table turns mutation on "unless mutation-full is on": the whole of src/ covers any area.
[ -z "$on_full" ] || on_mutation=""

invoking=$(git rev-parse --show-toplevel 2>/dev/null) || {
    printf 'not a git repository: %s\n' "$PWD" >&2
    exit 1
}
common=$(git rev-parse --path-format=absolute --git-common-dir) || exit 1
parent=$(cd "$(dirname "$common")/.." && pwd -P) || exit 1
# Next to the main worktree, like the task trees. Compose takes the project name of a gate's
# container from the directory name, so the name carries the PR number: reviews of two PRs get an
# image and a volume each, and nothing of the application of a task tree is touched.
tree="$parent/telegram-bot-review-$pr"
base_tree="$parent/telegram-bot-review-$pr-base"
scripts_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 1
tmp=${TMPDIR:-/tmp}
logs=$(mktemp -d "${tmp%/}/review-run-$pr.XXXXXX") || exit 1
cd "$invoking" || exit 1

# The report goes to the output the script started with. A signal is handled once the command that
# was running finishes, and inside the redirection of that command: a report printed there would go
# into the log of a gate.
exec 3>&1 4>&2

# make review-run passes its own command-line variables (pr=, gates= and the rest) down to every make
# below through MAKEFLAGS, and a files= given to it by mistake would narrow make mutation of the PR.
# MAKELEVEL would make every nested make print its directory into the logs.
unset MAKEFLAGS MFLAGS MAKELEVEL

say() {
    section=$1
    shift
    printf '%s\n' "$*" >>"$logs/out.$section"
}

strip() {
    sed "s/${ESC}\[[0-9;]*[A-Za-z]//g"
}

# The first line that names a failure, or the first non-empty one: the verdict takes one line of an
# error, and the whole log stays in the logs directory.
first_line() {
    strip <"$1" | awk '
        { sub(/^[ \t]+/, "") }
        tolower($0) ~ /error|cannot|fatal|denied|refused|failed|not found/ { print; found = 1; exit }
        first == "" && NF { first = $0 }
        END { if (!found && first != "") print first }
    '
}

stopped=""
interrupted=""
made=""

# The run cannot start or go on: every gate that has not run yet gets n-a with this reason.
abort() {
    stopped=$1
    exit 1
}

# down goes from the tree itself and before its removal: Compose takes the project name from the
# directory, and without the directory there is nowhere to take it from — the image of the tree
# (about a gigabyte) and its volume would be orphaned. --remove-orphans takes the container of a gate
# a killed run left behind: docker compose lets its client go and the container carries on, and
# without the flag down skips it, leaves the image and the volume "in use" and still exits with 0.
# down does not touch the shared database: it is a separate project, telegram-bot-db.
# make worktree-cleanup does not fit here: it requires the branch merged into main on origin and
# deletes it there, while the PR under review is alive.
# The price: the next round of the same PR builds its image anew — the throwaway container builds it
# only when there is none — that is a build from the layer cache per round against a gigabyte left on
# disk by every one.
remove_tree() {
    if [ -d "$1" ]; then
        if ! (cd "$1" && docker compose -f "$COMPOSE_FILE" down --rmi local --volumes --remove-orphans) >"$logs/down.log" 2>&1; then
            # Docker does not answer. Without the directory this command could no longer remove the
            # image, so the tree stays for a human.
            say notclean "Not cleaned up: $1 — $(first_line "$logs/down.log")"
            return 1
        fi
    fi
    # --force twice: once for the untracked .env, coverage and reports, once for the lock.
    if ! git -C "$invoking" worktree remove --force --force "$1" >"$logs/remove.log" 2>&1; then
        say notclean "Not cleaned up: $1 — $(first_line "$logs/remove.log")"
        return 1
    fi
}

# A tree at this path already exists — left by a run that did not reach its cleanup (kill -9 cannot
# be trapped) or whose cleanup Docker did not answer. A live run keeps its tree locked with its pid in
# the reason (make_tree), and such a tree is not touched.
sweep() {
    listed=$(git worktree list --porcelain | awk -v p="worktree $1" '
        $0 == p { found = 1; print "listed"; next }
        found && /^locked/ { sub(/^locked ?/, ""); print; exit }
        found && /^$/ { exit }
    ')
    [ -n "$listed" ] || [ -e "$1" ] || return 0
    pid=$(printf '%s\n' "$listed" | sed -n 's/^review-run pid \([0-9][0-9]*\)$/\1/p')
    # The process is asked for its command, not just whether it lives: after a reboot the pid of a
    # lock may belong to anything, and such a lock would hold the tree until that process ends.
    if [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -q 'review-run\.sh'; then
        blocker="$1 is held by another review run (pid $pid)"
        return 1
    fi
    if ! remove_tree "$1"; then
        blocker="$1 is left by an earlier run and could not be removed"
        return 1
    fi
    say notes "Removed the tree an earlier run left behind: $1"
}

# A detached checkout of the commit: no branch is created or moved, and the PR branch may be checked
# out in the author's tree at the same time. The lock carries the pid for sweep().
# .env is copied rather than made by make worktree-init: that one takes a slot of the token pool,
# while the throwaway containers of the gates need no bot and do not read the token.
make_tree() {
    sweep "$1" || return 1
    if ! git worktree add --quiet --detach --lock --reason "review-run pid $$" "$1" "$2" >"$logs/add.log" 2>&1; then
        blocker="git worktree add $1 failed: $(first_line "$logs/add.log")"
        return 1
    fi
    made="$made $1"
    if ! cp "$invoking/.env" "$1/.env"; then
        blocker="could not copy .env into $1"
        return 1
    fi
}

# The base of a comparison: main on origin as it is now, fetched by its commit for the same reason as
# the head of the PR below. Made once, on the first red that needs it.
base_state=""
base_head=""
base_why=""
base_ready() {
    case $base_state in
        ready) return 0 ;;
        failed) return 1 ;;
    esac
    base_state=failed
    base_head=$(git ls-remote --exit-code origin refs/heads/main 2>"$logs/base.log" | cut -f1)
    if [ -z "$base_head" ]; then
        base_why="main on origin was not read: $(first_line "$logs/base.log")"
        return 1
    fi
    if ! git cat-file -e "$base_head^{commit}" 2>/dev/null &&
        ! git fetch --quiet --no-write-fetch-head origin "$base_head" >"$logs/base.log" 2>&1; then
        base_why="main on origin was not fetched: $(first_line "$logs/base.log")"
        return 1
    fi
    if ! make_tree "$base_tree" "$base_head"; then
        base_why=$blocker
        return 1
    fi
    base_short=$(printf '%s' "$base_head" | cut -c1-7)
    base_state=ready
}

# An item of "Red" in the shape of the verdict: the command, the first meaningful line of its error
# and the comparison with the base when there is one. Under it go at most forty lines that explain
# the red, picked by the shape of the tool's output; a shape not recognised gives the tail. The whole
# log stays in the logs directory.
red_item() {
    case $2 in
        build | typecheck) strip <"$3" | grep -E 'error TS[0-9]+|Found [0-9]+ errors?|Missing script' ;;
        test) strip <"$3" | awk '
            /^ *[0-9]+ failing/ { on = 1 }
            on && /^-+\|/ { on = 0 }
            on || /ERROR: Coverage for|Missing script/
        ' ;;
        lint) strip <"$3" | awk '
            /^\/app\// { on = 1 }
            on || /Missing script/
            /problems? \(/ { on = 0 }
        ' | sed 's#^/app/##' ;;
        format-check) strip <"$3" | grep -E '^\[(warn|error)\]|Missing script' ;;
        mutation) strip <"$3" | grep -E 'ERROR|(Checker|Child) process|Something went wrong|^make mutation: |Final mutation score' | tail -n 20 ;;
        *) : ;;
    esac >"$logs/excerpt.raw" 2>/dev/null
    # The tail without the progress of the image build and of Compose, which fill the end of a log.
    [ -s "$logs/excerpt.raw" ] || strip <"$3" |
        grep -vE '^[[:space:]]*$|^#[0-9]+ |^ *(Container|Image|Volume|Network) ' | tail -n 20 >"$logs/excerpt.raw"
    # A run of blank lines is squeezed into one, and the trailing ones go.
    awk 'NF { if (blank) print ""; blank = 0; print; next } { blank = 1 }' "$logs/excerpt.raw" >"$logs/excerpt.all"
    head -n 40 "$logs/excerpt.all" >"$logs/excerpt"
    say red "- $1 — $(first_line "$logs/excerpt")${4:+ [$4]}"
    sed 's/^/    /' "$logs/excerpt" >>"$logs/out.red"
    if [ "$(grep -c '' "$logs/excerpt.all")" -gt 40 ]; then
        say red "    … cut at forty lines, the whole log: $3"
    fi
}

# One gate of the table: its command in the current directory, the tree of the PR or of the base.
run_gate() {
    case $1 in
        build) make build ;;
        typecheck) make typecheck ;;
        test) make coverage ;;
        lint) make lint ;;
        format-check) make format-check ;;
    esac >"$2" 2>&1
}

# The survivors and uncovered mutants of a run record, a line each as the record writes them.
survivors() {
    grep -E '^- (Survived|NoCoverage) · ' "$1" 2>/dev/null
}

# A run of the gate's target, whole or over an area. How it ended is read from its log: a run that
# reached the report is judged by its exit code, one that broke off is told apart by the lines
# docs/architecture/testing.md, "The type checker", explains.
mutate() {
    if [ -n "$2" ]; then
        make mutation files="$2" >"$1" 2>&1
    else
        make mutation >"$1" 2>&1
    fi
    mutate_exit=$?
    if grep -q 'Final mutation score' "$1"; then
        mutate_end=finished
    elif grep -q 'Checker process .* ran out of memory' "$1"; then
        # The checker hit its own heap limit: the neighbours have nothing to do with it, and every
        # run fails the same way.
        mutate_end=oom
    elif grep -q 'Checker process .* crashed with exit code null' "$1"; then
        # Killed by SIGKILL: the memory of Docker is one for all the trees, and a build or somebody
        # else's run next door takes it. A failure of the machine, not of the code.
        mutate_end=crashed
    elif grep -q 'Child process \[pid ' "$1" && ! grep -q 'Checker process' "$1" &&
        ! grep -q 'Something went wrong in the initial test run' "$1"; then
        # The checker failed on the initial compilation, which has no retry. Child process lines
        # alone say nothing — they are written about the runner too, whose crash on a mutant does
        # not break the run off — but a run that broke off with them, without a Checker process line
        # and without a failed initial test run is this case.
        mutate_end=crashed
    else
        # Broken off otherwise — a failed initial test run, an error of the config: read as usual,
        # by the exit code.
        mutate_end=finished
    fi
}

# The last run record in the PR replaces the gate's own run when it holds for this head
# (docs/architecture/testing.md, "The run record"; docs/agents/review-gates.md, "Changes that affect
# the mutation run"). Only a comment that starts with the marker counts: the wrapper writes it as the
# first line, while a quote of the marker in a discussion would pass itself off as a run. Returns 1
# with the refusal; returns 0 with proviso set when condition 1 waits for the reviewer's reading.
accept_record() {
    refusal=""
    proviso=""
    rec_url=""
    rec_head=""
    if [ -n "$record_mode" ]; then
        refusal="record=refuse came in: the changes since the head of the record affect the run"
        return 1
    fi
    if ! gh pr view "$pr" --json comments \
        -q '[.comments[] | select(.body | test("^<!-- mutation-record "))] | last // empty | .url, .body' \
        >"$logs/record.txt" 2>"$logs/gh.log"; then
        refusal="the records of the PR were not read: $(first_line "$logs/gh.log")"
        return 1
    fi
    if [ ! -s "$logs/record.txt" ]; then
        refusal="there is no record in the PR"
        return 1
    fi
    rec_url=$(sed -n 1p "$logs/record.txt")
    sed 1d "$logs/record.txt" >"$logs/record.md"
    marker=$(sed -n 1p "$logs/record.md")
    rec_head=$(printf '%s\n' "$marker" | sed -n 's/.* head=\([^ ]*\).*/\1/p')
    rec_short=$(printf '%s' "$rec_head" | cut -c1-7)
    rec_clean=$(printf '%s\n' "$marker" | sed -n 's/.* clean=\([^ ]*\).*/\1/p')
    rec_scope=$(printf '%s\n' "$marker" | sed -n 's/.* scope=\([^ ]*\).*/\1/p')
    rec_exit=$(printf '%s\n' "$marker" | sed -n 's/.* exit=\([^ ]*\).*/\1/p')
    rec_score=$(printf '%s\n' "$marker" | sed -n 's/.* score=\([^ ]*\).*/\1/p')
    reasons=""

    # Condition 2: a run on a dirty tree checked something other than the commit.
    [ "$rec_clean" = yes ] || reasons="$reasons; clean=$rec_clean"
    # Condition 3: the run reached the report, and its area is the gate's. A full record is not taken
    # under mutation although its area covers: the outcome of the gate is the exit code of the whole
    # run, and a survivor in a file the PR did not touch would paint it red, while an area without
    # mutants would give ok instead of n-a. A run of the area takes seconds.
    [ "$rec_score" != none ] || reasons="$reasons; score=none: the run did not reach the report"
    if [ -n "$on_full" ]; then
        [ "$rec_scope" = full ] || reasons="$reasons; scope=$rec_scope, while mutation-full needs the whole of src/"
    elif [ "$rec_scope" != files ]; then
        reasons="$reasons; scope=$rec_scope, while mutation needs a run of the area"
    else
        # A file of the area counts as covered when the record lists it among the mutated files or
        # names it in files: a file without a single mutant never gets into the Stryker report, so a
        # file of types alone is visible in the record only as a named path.
        listed=$(
            grep -E '^src/[^ ]+\.ts$' "$logs/record.md"
            sed -n 's/^- files: `\([^`]*\)`$/\1/p' "$logs/record.md" | tr ' ' '\n'
        )
        missing=""
        for file in $area; do
            printf '%s\n' "$listed" | grep -qxF "$file" || missing="$missing $file"
        done
        [ -z "$missing" ] || reasons="$reasons; the area of the record lacks$missing"
    fi
    # A list of survivors cut off: the rest lies only on the machine of the run, and there would be
    # nothing to repeat on every file with survivors.
    ! grep -q '^- …and [0-9]* more' "$logs/record.md" || reasons="$reasons; its list of survivors is cut off"
    # Condition 4: the author's run might have gone on an old image.
    [ -z "$on_rebuild" ] || reasons="$reasons; the rebuild gate is on"

    # Condition 1: the record covers the head — the same commit, or nothing that affects the run
    # changed since. The diff is between the trees of the two commits, not from their merge-base:
    # after a rebase the head of the record is no longer an ancestor, and the branch's own changes
    # would count. A head that is not in the repository (a force-push lost it) has nothing to compare
    # with. --no-renames: a move shows only its new path, and a file moved out of src/ would pass
    # unseen.
    if [ "$rec_head" != "$head" ]; then
        if ! git cat-file -e "$rec_head^{commit}" 2>/dev/null; then
            reasons="$reasons; its head $rec_short is not in the repository"
        else
            stale=""
            for file in $(git diff --no-renames --name-only "$rec_head" "$head"); do
                # The rows rebuild, mutation-full and mutation of the table in
                # docs/agents/review-gates.md, by file name. The table is the source, and a change of
                # these rows there is made here too. The files whose row depends on the content of
                # the change — a diff of comments only leaves mutation-full off, and the Makefile
                # turns it on only through the mutation recipe — are the reviewer's reading.
                case $file in
                    src/*.ts | test/*.ts) stale="$stale $file" ;;
                    package.json | package-lock.json | Dockerfile | .eslintrc.js | .prettierrc.js | .mocharc.json) stale="$stale $file" ;;
                    stryker.config.mjs | test/stryker-mocha-hook.cjs | tsconfig.json | tsconfig.check.json | Makefile) proviso="$proviso $file" ;;
                esac
            done
            [ -z "$stale" ] || reasons="$reasons; since its head $rec_short changed$stale"
        fi
    fi

    if [ -n "$reasons" ]; then
        refusal=$(printf '%s' "$reasons" | sed 's/^; //')
        return 1
    fi
}

# The record of the gate's own run goes into the PR as soon as the run is over: a repeat overwrites
# reports/mutation/record.md, and the cleanup deletes the tree together with it. The record of the
# run that decided the gate is the one published — after a checker crash that is its repeat, since
# the run that broke off carries score=none and no review would accept it. The repeats of the red are
# not published, so that the gate's record stays the last in the PR. --no-post cancels this
# publication too.
publish() {
    if [ -n "$no_post" ]; then
        published="not published (--no-post)"
    elif [ ! -s "$logs/gate-record.md" ]; then
        published="no record: the wrapper did not write one"
    else
        { cat "$logs/gate-record.md"; printf '\n%s\n' "$SIGNATURE"; } >"$logs/record-post.md"
        if url=$(gh pr comment "$pr" --body-file "$logs/record-post.md" 2>"$logs/post.log"); then
            published=$url
        else
            published="not published: $(first_line "$logs/post.log")"
        fi
    fi
}

# The red of a mutation gate is repeated on every file with survivors: the threshold of 100 has no
# margin, and under load a mutant's status lies both ways (docs/architecture/testing.md, "Timeouts
# and errors"). The mutants of other files do not affect these, so the whole area is not repeated. A
# repeat refines the red but does not turn it green: under load a survivor hides both under Timeout
# and under Killed with the ordinary message of a spec, and review has no idle machine to tell drift
# from a survivor.
mutation_red() {
    survivors "$logs/gate-record.md" >"$logs/gate-survivors"
    if [ ! -s "$logs/gate-survivors" ]; then
        if [ -n "$gate_log" ]; then
            red_item "make mutation" mutation "$gate_log" "exit $gate_exit without a single survivor in the record"
        else
            say red "- the accepted record — exit $gate_exit without a single survivor in it"
        fi
        return
    fi
    # Only the own run gets here with a cut list: an accepted record never has one.
    more=$(sed -n 's/^- …and \([0-9][0-9]*\) more.*/\1/p' "$logs/gate-record.md")
    if [ -n "$more" ]; then
        say red "- the record names the survivors only up to its size limit: $more more are not named, and their files are neither repeated nor compared with the base; the whole report: $logs/gate-mutation.html"
    fi
    for file in $(sed -n 's/^[^`]*`\([^:`]*\):[0-9]*:[0-9]*`.*/\1/p' "$logs/gate-survivors" | LC_ALL=C sort -u); do
        grep -F "\`$file:" "$logs/gate-survivors" >"$logs/file-survivors"
        count=$(grep -c '' "$logs/file-survivors")
        : >"$logs/file-red"
        mutate "$logs/repeat.log" "$file"
        if [ "$mutate_end" != finished ]; then
            say red "- make mutation files=\"$file\" — $count survived or uncovered [the repeat broke off on a checker crash: not rechecked]"
            sed 's/^/    /' "$logs/file-survivors" >>"$logs/out.red"
            continue
        fi
        cp reports/mutation/record.md "$logs/repeat-record.md" 2>/dev/null || : >"$logs/repeat-record.md"
        confirmed=0
        while IFS= read -r line; do
            if grep -qxF -- "$line" "$logs/repeat-record.md"; then
                printf '    %s — confirmed by the repeat\n' "$line" >>"$logs/file-red"
                confirmed=$((confirmed + 1))
            else
                printf '    %s — possible drift: recheck on an idle machine\n' "$line" >>"$logs/file-red"
            fi
        done <"$logs/file-survivors"
        # Red on the base too does not change the verdict. The file runs there alone, and the lines of
        # the two runs move with the PR's edits, so the reviewer matches a survivor by its mutator and
        # replacement.
        : >"$logs/base-survivors"
        if [ "$confirmed" -eq 0 ]; then
            compared="none confirmed by the repeat, so not compared with the base"
        elif ! base_ready; then
            compared="not compared with the base: $base_why"
        elif ! git -C "$base_tree" ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
            compared="brought by this PR: the file is not on origin/main $base_short"
        else
            cd "$base_tree" || abort "could not enter $base_tree"
            mutate "$logs/base-mutation.log" "$file"
            if [ "$mutate_end" != finished ]; then
                compared="not compared with the base: the run on origin/main $base_short broke off on a checker crash"
            elif survivors reports/mutation/record.md >"$logs/base-survivors"; then
                compared="red on the base too: origin/main $base_short, its survivors below — match them by mutator and replacement"
            else
                compared="brought by this PR: green on origin/main $base_short"
            fi
            cd "$tree" || abort "could not return into $tree"
        fi
        say red "- make mutation files=\"$file\" — $count survived or uncovered, $confirmed confirmed [$compared]"
        cat "$logs/file-red" >>"$logs/out.red"
        [ ! -s "$logs/base-survivors" ] || sed 's/^/    origin\/main: /' "$logs/base-survivors" >>"$logs/out.red"
    done
}

# At a threshold of 100 silencing a survivor with a mark is cheaper than writing a test, so a green
# run does not yet mean there are no survivors. Whether the reason of a mark holds is the reviewer's
# reading, against "Working through survivors" in docs/architecture/testing.md.
stryker_marks() {
    if ! gh pr diff "$pr" >"$logs/pr.diff" 2>"$logs/gh.log"; then
        say material "New Stryker disable marks: not read — gh pr diff $pr failed: $(first_line "$logs/gh.log")"
        return
    fi
    awk '/^\+\+\+ /{ f = substr($0, 7); next } /^\+.*Stryker disable/{ print f ": " $0 }' "$logs/pr.diff" >"$logs/marks"
    if [ -s "$logs/marks" ]; then
        say material "New Stryker disable marks — check the reason of each against \"Working through survivors\" in docs/architecture/testing.md; a reason that does not hold makes the mutation gate fail:"
        sed 's/^/    /' "$logs/marks" >>"$logs/out.material"
    else
        say material "New Stryker disable marks: none"
    fi
}

# Which threshold make mutation checks and why a run without mutants is green —
# docs/architecture/testing.md, "Threshold".
mutation_gate() {
    stryker_marks
    # area goes into files= of make mutation, area_text into the report; under mutation-full the
    # first stays empty, since without files= the target mutates the whole of src/.
    area=""
    area_text="the whole src/"
    if [ -z "$on_full" ]; then
        # The area is assembled in the tree of the PR by the one copy of the rule.
        if ! area=$("$scripts_dir/mutation-area.sh" "$pr" 2>"$logs/area.log"); then
            m_line="mutation: n-a — the area was not assembled: $(first_line "$logs/area.log")"
            return
        fi
        if [ -z "$area" ]; then
            notes=$(grep -v '^the area is empty' "$logs/area.log" | tr '\n' ';' | sed 's/;$//; s/;/; /g')
            m_line="mutation: n-a — the area is empty${notes:+: $notes}"
            return
        fi
        area_text=$(printf '%s' "$area" | tr '\n' ' ')
    fi

    gate_end=finished
    gate_log=""
    if accept_record; then
        gate_exit=$rec_exit
        gate_score=$rec_score
        cp "$logs/record.md" "$logs/gate-record.md"
        # The link, not the author: a reviewer's record of an earlier round lies in the same thread
        # and is accepted on a par with the author's, and the account that posts both is one.
        source="accepted record, $rec_url"
        if [ -n "$proviso" ]; then
            source="$source (its head $rec_short is earlier: it holds if the changes to$proviso since then are comments only and leave the mutation recipe alone — yours to read below; otherwise call again with record=refuse)"
            say material "The changes since the head $rec_short of the record that decide whether it covers $short (docs/agents/review-gates.md, the mutation-full row):"
            git diff "$rec_head" "$head" -- $proviso | sed 's/^/    /' >>"$logs/out.material"
        elif [ "$rec_head" != "$head" ]; then
            source="$source (its head $rec_short is earlier — nothing under the mutation gates came in since)"
        fi
    else
        gate_log="$logs/mutation.log"
        mutate "$gate_log" "$area"
        # A checker killed by the machine is repeated once; broken off again, there is nothing to
        # judge the mutants by.
        if [ "$mutate_end" = crashed ]; then
            gate_log="$logs/mutation-repeat.log"
            mutate "$gate_log" "$area"
        fi
        gate_end=$mutate_end
        gate_exit=$mutate_exit
        gate_score=$(sed -n '1s/.* score=\([^ ]*\) -->$/\1/p' reports/mutation/record.md 2>/dev/null)
        cp reports/mutation/record.md "$logs/gate-record.md" 2>/dev/null || : >"$logs/gate-record.md"
        # The whole report outlives the tree: the record cuts its list of survivors at its size
        # limit, and the rest is only here.
        cp reports/mutation/mutation.html "$logs/gate-mutation.html" 2>/dev/null
        publish
        source="own run, $published — the record was not accepted: $refusal"
    fi

    case $gate_end in
        crashed)
            m_line="mutation: n-a — the run broke off on a checker crash, and so did its repeat: nobody checked the mutants of the PR, $area_text · $source"
            ;;
        oom)
            m_line="mutation: fail — the checker ran out of memory: it lacks the heap limit of checkerNodeArgs on the tree of this PR, $area_text · $source"
            red_item "make mutation" mutation "$gate_log"
            ;;
        *)
            if [ "$gate_score" = NaN ]; then
                # Not a single mutant of the area got into the score, and the green exit checked
                # nothing (docs/architecture/testing.md, "Threshold").
                m_line="mutation: n-a — score NaN, $area_text: not a single mutant of the area got into the score · $source"
            elif [ "$gate_exit" = 0 ]; then
                m_line="mutation: ok — $gate_score, $area_text · $source"
            else
                m_line="mutation: fail — ${gate_score:-no score}, $area_text · $source"
                mutation_red
            fi
            ;;
    esac
}

# The value of a gate in the first line: a gate turned on that did not run is n-a and goes into the
# "Not run" line, since what was not run is not hushed up.
state() {
    if [ -z "$1" ]; then
        printf 'n-a'
    elif [ -n "$2" ]; then
        printf '%s' "$2"
    else
        printf 'n-a'
        printf '%s\n' "$3" >>"$logs/notrun"
    fi
}

# Every temporary tree is removed whatever the outcome — a red gate, a stop halfway and an interrupt
# included — and only then is the report printed, so that a tree left behind makes it into the
# report.
finish() {
    code=$?
    trap '' INT TERM HUP
    exec 1>&3 2>&4
    cd "$invoking" || :
    for path in $made; do
        remove_tree "$path"
    done
    [ -z "$interrupted" ] || stopped="the run was interrupted"

    if [ -n "$on_rebuild" ]; then
        rebuild=$(state 1 "${r_rebuild:-}" rebuild)
    else
        rebuild="not needed"
    fi
    build=$(state "$on_build" "${r_build:-}" build)
    typecheck=$(state "$on_typecheck" "${r_typecheck:-}" typecheck)
    test=$(state "$on_test" "${r_test:-}" test)
    lint=$(state "$on_lint" "${r_lint:-}" lint)
    format=$(state "$on_format" "${r_format:-}" format-check)
    state "$on_targets" "${r_targets:-}" make-targets >/dev/null
    state "$on_scripts" "${r_scripts:-}" scripts >/dev/null
    state "$on_mutation$on_full" "${m_line:-}" mutation >/dev/null
    [ -z "$on_mutation$on_full" ] || [ -n "${m_line:-}" ] || m_line="mutation: n-a"

    printf 'Run of PR #%s · head %s · logs %s\n' "$pr" "${short:-unknown}" "$logs"
    printf 'rebuild: %s · build: %s · typecheck: %s · test: %s · lint: %s · format-check: %s\n' \
        "$rebuild" "$build" "$typecheck" "$test" "$lint" "$format"
    [ -z "${m_line:-}" ] || printf '%s\n' "$m_line"
    [ ! -s "$logs/out.checks" ] || cat "$logs/out.checks"
    if [ -s "$logs/notrun" ]; then
        printf 'Not run: %s — %s\n' "$(paste -s -d , "$logs/notrun" | sed 's/,/, /g')" "${stopped:-the run stopped before them}"
        code=1
    fi
    for gate in $unknown; do
        printf 'Not run: %s — not a gate of the run (docs/agents/review-gates.md), nothing is run for it\n' "$gate"
        code=1
    done
    if [ -s "$logs/out.notclean" ]; then
        cat "$logs/out.notclean"
        code=1
    fi
    [ ! -s "$logs/out.notes" ] || cat "$logs/out.notes"
    if [ -s "$logs/out.red" ]; then
        printf '\nRed:\n'
        cat "$logs/out.red"
        code=1
    fi
    if [ -s "$logs/out.material" ]; then
        printf '\nYours to read:\n'
        cat "$logs/out.material"
    fi
    exit "$code"
}

trap finish EXIT
trap 'interrupted=1; exit 130' INT
trap 'interrupted=1; exit 143' TERM
trap 'interrupted=1; exit 129' HUP

if [ -z "$on_rebuild$on_build$on_typecheck$on_test$on_lint$on_format$on_targets$on_scripts$on_mutation$on_full" ]; then
    say notes "No run gate among \"$gates\": nothing was run"
    exit 0
fi

# Step 1. Preparation.

# No .env — the run does not make one: make worktree-init takes a slot of the token pool, and the
# main worktree gets its .env from .env.dist by hand.
[ -f .env ] || abort "no .env in $invoking: make worktree-init is needed there (the main worktree takes a copy of .env.dist)"

# The database first, from the tree the review started in and never from the temporary one. Its
# project name is fixed (name: telegram-bot-db in docker-compose.db.yml), and its data directory
# ./tmp/pgsql leads into the main tree only through the symlink scripts/worktree-init.sh sets. A
# temporary tree has no such link, and make db-up from it recreates the shared container on an empty
# tmp/pgsql: every tree silently moves to a clean database without migrations, and a run on it is
# green and notices nothing. The gates need the database up: the application's network is declared
# external and belongs to the database project, and the specs go to the database itself.
make db-up >"$logs/db-up.log" 2>&1 || abort "make db-up failed: $(first_line "$logs/db-up.log")"

head=$(gh pr view "$pr" --json headRefOid -q .headRefOid 2>"$logs/gh.log") && [ -n "$head" ] ||
    abort "gh pr view $pr failed: $(first_line "$logs/gh.log")"
short=$(printf '%s' "$head" | cut -c1-7)

# By the commit, not by the branch: the run checks exactly the head the verdict names. No ref is
# written: origin/main and the remote branches are shared by every tree, and a neighbour's fetch
# holding one would refuse this one (the same reason as at the first fetch of
# scripts/worktree-cleanup.sh). The objects are shared by the trees too, so a head the author
# committed on this machine is already here.
git cat-file -e "$head^{commit}" 2>/dev/null ||
    git fetch --quiet --no-write-fetch-head origin "$head" >"$logs/fetch.log" 2>&1 ||
    abort "the head $short of PR #$pr was not fetched: $(first_line "$logs/fetch.log")"

gh pr diff "$pr" --name-only >"$logs/files" 2>"$logs/gh.log" ||
    abort "gh pr diff $pr failed: $(first_line "$logs/gh.log")"

make_tree "$tree" "$head" || abort "$blocker"
cd "$tree" || abort "could not enter $tree"

# Step 2. The run by gates.

# rebuild goes first. The throwaway container of a gate takes the ready image and builds it itself
# only when there is none. This tree's image normally went with the cleanup of the previous run, but
# one a failed cleanup left behind would check new code against old dependencies and an old config,
# and give a green that means nothing (the comment on the rebuild target in the Makefile).
if [ -n "$on_rebuild" ]; then
    if make rebuild >"$logs/rebuild.log" 2>&1; then
        r_rebuild=done
    else
        r_rebuild=fail
        red_item "make rebuild" rebuild "$logs/rebuild.log"
        stopped="the image of the PR did not build (make rebuild)"
    fi
fi

# make -n prints a recipe without running it — the check of how the variables expand, with no side
# effects. GNU make runs the lines with $(MAKE) even under -n, but passes -n on through MAKEFLAGS, so
# the nested make only prints too. Whether an expansion is right is the reviewer's reading, so the
# output goes to the material as it is.
if [ -n "$on_targets" ]; then
    r_targets=1
    make help >"$logs/help.log" 2>&1 || say checks "make help: fail — $(first_line "$logs/help.log")"
    phony=$(awk '
        /^\.PHONY:/ { on = 1; sub(/^\.PHONY:/, "") }
        on { line = $0; more = sub(/\\$/, "", line); printf "%s ", line; if (!more) on = 0 }
    ' Makefile 2>/dev/null)
    [ -n "$targets" ] || say material "make -n: no targets= came in, so no expansion is printed — name the targets the Makefile diff changes"
    for target in $targets; do
        help_line=$(strip <"$logs/help.log" | awk -v t="$target" '$1 == t' | sed 's/^ *//')
        case " $phony " in
            *" $target "*) in_phony=yes ;;
            *) in_phony=no ;;
        esac
        make -n "$target" >"$logs/make-n.log" 2>&1
        say material "make -n $target (exit $?) — whether the variables are substituted, no argument is left empty, a multi-line files= is not glued into one command:"
        say material "    make help: ${help_line:-absent — the target has no ## description}"
        say material "    .PHONY: $in_phony"
        strip <"$logs/make-n.log" | sed 's/^/    | /' >>"$logs/out.material"
    done

    # The recipe of mutation counts MUTATION_DIRTY — the clean= field of the run record, on which the
    # acceptance of a record rests. make -n prints the chain tree=…&&dirty=…||dirty=unknown but does
    # not run it, and a full run goes on a clean tree, where clean=yes is expected anyway: a recipe
    # that counts 0 on a failing git or a dirty tree looks sound under both gates, and review would
    # accept a run that did not go on the PR's commit. So the real recipe runs with the container
    # launch replaced by echo — DC_APP_RUN is a simple assignment in the Makefile, and a command-line
    # value overrides it — and prints the counted values in a second. The line taken is the executed
    # one: make also prints the recipe itself, where MUTATION_DIRTY="$dirty" is not expanded yet. With
    # git that does not answer the head goes empty too, and that is expected: on an empty head the
    # wrapper sets clean=unknown itself (docs/architecture/testing.md, "The run record").
    : >"$logs/probes.lines"
    probe() {
        make mutation DC_APP_RUN=echo "$@" 2>>"$logs/probes.log" | strip | grep '^env ' >"$logs/probe.line"
        cat "$logs/probe.line" >>"$logs/probes.lines"
        sed -n 's/.* MUTATION_DIRTY=\([^ ]*\).*/\1/p' "$logs/probe.line"
    }
    clean_count=$(probe)
    # The probe file is untracked and removed right after, so the tree stays the one that was sent;
    # the reports directory the target creates even without a run is in .gitignore.
    : >mutation-dirty-probe
    dirty_count=$(probe)
    rm -f mutation-dirty-probe
    unknown_count=$(probe GIT_DIR=/nonexistent)
    if [ "$clean_count" = 0 ] && [ "$dirty_count" = 1 ] && [ "$unknown_count" = unknown ]; then
        say checks "make mutation, the MUTATION_DIRTY substitution: ok — 0 on the clean tree, 1 with an untracked file, unknown when git does not answer"
    else
        say checks "make mutation, the MUTATION_DIRTY substitution: fail — the clean tree gave \"$clean_count\" (0 expected), an untracked file \"$dirty_count\" (1 expected), git that does not answer \"$unknown_count\" (unknown expected)"
        say red "- make mutation DC_APP_RUN=echo — the substitution counts something other than what goes into the run record"
        say material "The executed lines of the three probes of make mutation, in order (none — the recipe did not reach the launch):"
        sed 's/^/    | /' "$logs/probes.lines" >>"$logs/out.material"
    fi
fi

if [ -n "$on_scripts" ]; then
    r_scripts=1
    found=""
    for file in $(grep -E '^(scripts/.+\.sh|\.husky/.+)$' "$logs/files"); do
        [ -f "$file" ] || continue
        found=1
        if sh -n "$file" >"$logs/sh-n.log" 2>&1; then host=ok; else host=fail; fi
        # Always, not only when the body changed: the check costs a second and needs no reading of
        # whether a hunk is a comment.
        if docker run --rm -v "$PWD":/app -w /app "$DASH_IMAGE" sh -n "$file" >"$logs/dash.log" 2>&1; then
            dash=ok
        else
            dash=fail
        fi
        say checks "sh -n $file: $host (+ dash: $dash)"
        if [ "$host" = fail ]; then
            say red "- sh -n $file — $(first_line "$logs/sh-n.log")"
        fi
        if [ "$dash" = fail ]; then
            say red "- sh -n $file under dash — $(first_line "$logs/dash.log")"
        fi
    done
    [ -n "$found" ] || say checks "sh -n: n-a — no script of the diff is left in the tree"
fi

# build and typecheck both run tsc, but by different tsconfigs, and neither replaces the other: the
# file set of typecheck is wider (tsconfig.check.json says what and why), so a green build on a PR
# that touches specs or migrations says nothing about their types. lint and format-check go over the
# whole repository without files=: it is green as a whole, so anything red was brought by this PR or
# is red on the base too — the comparison below tells which.
failed=""
if [ -z "$stopped" ]; then
    for gate in build typecheck test lint format-check; do
        case $gate in
            build) on=$on_build ;;
            typecheck) on=$on_typecheck ;;
            test) on=$on_test ;;
            lint) on=$on_lint ;;
            format-check) on=$on_format ;;
        esac
        [ -n "$on" ] || continue
        if run_gate "$gate" "$logs/$gate.log"; then
            result=ok
        else
            result=fail
            failed="$failed $gate"
        fi
        if [ "$gate" = test ]; then
            counts=$(strip <"$logs/test.log" | sed -nE 's/^ *([0-9]+) (passing|failing).*/\1 \2/p' | paste -s -d , - | sed 's/,/, /g')
            [ -z "$counts" ] || result="$result ($counts)"
        fi
        case $gate in
            build) r_build=$result ;;
            typecheck) r_typecheck=$result ;;
            test) r_test=$result ;;
            lint) r_lint=$result ;;
            format-check) r_format=$result ;;
        esac
    done
fi

# Red that is red on the base too does not change the verdict, and which of the two it is only a run
# tells: the failed command alone runs on main on origin. The red of make -n and sh -n is not
# compared: it is unambiguous by itself.
for gate in $failed; do
    command="make $gate"
    [ "$gate" != test ] || command="make coverage"
    if ! base_ready; then
        compared="not compared with the base: $base_why"
    elif (cd "$base_tree" && run_gate "$gate" "$logs/$gate-base.log"); then
        compared="brought by this PR: green on origin/main $base_short"
    else
        compared="red on the base too: origin/main $base_short"
    fi
    red_item "$command" "$gate" "$logs/$gate.log" "$compared"
done

# Last and alone: every other gate is over, and nothing else runs while the mutants do — under load
# a mutant's status lies both ways. A run of the whole src/ also outlasts the ten minutes of one
# command of the reviewer, who runs the target in the background (pr-light-check, step 1).
if [ -n "$on_mutation$on_full" ] && [ -z "$stopped" ]; then
    mutation_gate
fi

exit 0
