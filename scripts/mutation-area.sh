#!/usr/bin/env sh
# Prints the mutation area of a diff, one path per line: the sources under src/ whose mutants the
# change can affect — the files= of make mutation. The rule has two users, and this is its only
# copy: the review gate `mutation` (scripts/review-run.sh) takes the candidates from the diff of a
# PR, the author before a PR (.claude/commands/solve-issue.md) from the diff of their branch.
#
#   scripts/mutation-area.sh        the candidates of git diff --name-only origin/main...HEAD
#   scripts/mutation-area.sh <PR>   the candidates of gh pr diff <PR> --name-only
#
# It runs in the tree whose code the area is for: which files exist, who imports a helper and what
# stryker.config.mjs excludes are read from there. An empty area prints nothing and says so on
# stderr: a caller must not run make mutation then, since without files= it mutates the whole of
# src/.
set -eu

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

# A list of paths is carried in variables one per line; the paths of the repository have no spaces
# or newlines of their own. LC_ALL=C: sort on a UTF-8 locale fails in the bash 3.2 of macOS.
unique() {
    printf '%s\n' "$@" | grep -v '^$' | LC_ALL=C sort -u || true
}

# The candidate source is the only difference between the two users. Each is taken with an exit
# code of its own: a failed git or gh inside a pipeline would read as an empty diff, that is as an
# empty area, and the run would silently check nothing.
if [ $# -eq 0 ]; then
    candidates=$(git diff --name-only origin/main...HEAD) || die "git diff origin/main...HEAD failed — the area was not assembled"
else
    case $1 in
        '' | *[!0-9]*) die "usage: $0 [<PR number>]" ;;
    esac
    candidates=$(gh pr diff "$1" --name-only) || die "gh pr diff $1 failed — the area was not assembled"
fi

# A source goes in as it is. A spec goes in as its mirror (test/a/b.spec.ts → src/a/b.ts): a PR that
# weakened a spec touches no source, and without the mirror it would have nothing to mutate. Any
# other .ts under test/ is a helper: the specs that import it give their mirrors, the helpers that
# import it are searched again, until nothing new is left. The mocha hooks (*-hook.ts) nobody
# imports, and they give no area.
sources=$(printf '%s\n' "$candidates" | grep -E '^src/.+\.ts$' || true)
specs=$(printf '%s\n' "$candidates" | grep -E '^test/.+\.spec\.ts$' || true)
queue=$(printf '%s\n' "$candidates" | grep -E '^test/.+\.ts$' | grep -vE '\.spec\.ts$' || true)
seen=$queue
while [ -n "$queue" ]; do
    helper=$(printf '%s\n' "$queue" | head -n 1)
    queue=$(printf '%s\n' "$queue" | sed 1d)
    # The specs import their shared code through the test/* alias only (docs/architecture/README.md),
    # so the import line is known exactly. git grep exits with 1 when nothing is found.
    importers=$(git grep -l -F "from \"${helper%.ts}\"" -- 'test/*.ts' || true)
    for file in $importers; do
        case $file in
            *.spec.ts) specs=$(unique $specs "$file") ;;
            *)
                if ! printf '%s\n' "$seen" | grep -qxF "$file"; then
                    seen=$(unique $seen "$file")
                    queue=$(unique $queue "$file")
                fi
                ;;
        esac
    done
done

mirrors=$(printf '%s\n' "$specs" | sed -n 's#^test/\(.*\)\.spec\.ts$#src/\1.ts#p')
wanted=$(unique $sources $mirrors)

# Only what exists in the tree is kept: a diff also names deleted files and the old paths of moves
# (PR #366), and a glob that found no .ts under src/ stops the run by the check in
# stryker.config.mjs. The guard is not an optimisation: git ls-files -- without a single path prints
# every file of the repository.
area=""
if [ -n "$wanted" ]; then
    area=$(git ls-files -- $wanted)
fi

# Not every spec lies as the mirror of its source: the specs of test/font-convertor/ are flat, while
# the sources are laid out in directories (docs/architecture/README.md, the rule for the specs). Such
# a spec's source is searched by file name; not found that way either — the source is not in the
# tree, and the spec gives no area.
for spec in $specs; do
    mirror=$(printf '%s\n' "$spec" | sed 's#^test/\(.*\)\.spec\.ts$#src/\1.ts#')
    if printf '%s\n' "$area" | grep -qxF "$mirror"; then
        continue
    fi
    name=$(basename "$spec" .spec.ts)
    found=$(git ls-files -- "src/**/$name.ts")
    if [ -n "$found" ]; then
        area=$(unique $area $found)
    else
        printf 'no source for %s in the tree — the spec gives no area\n' "$spec" >&2
    fi
done

# The config excludes src/app.ts and DATABASE_ONLY_SOURCES from any area itself, but an area made of
# such files alone passes the config's check and gives a run without a single mutant. The list is
# read from the config of this tree rather than repeated here; not found — the area is not
# assembled, or the subtraction would silently stop working.
excluded=$(awk '
    /^const DATABASE_ONLY_SOURCES = \[/ { inside = 1; next }
    inside && /^\];/ { exit }
    inside && match($0, /"[^"]+"/) { print substr($0, RSTART + 1, RLENGTH - 2) }
' stryker.config.mjs) || die "stryker.config.mjs is not readable — the area was not assembled"
[ -n "$excluded" ] || die "DATABASE_ONLY_SOURCES is not found in stryker.config.mjs — the area was not assembled"
excluded=$(unique src/app.ts $excluded)

result=""
for file in $area; do
    if printf '%s\n' "$excluded" | grep -qxF "$file"; then
        printf '%s is left out: stryker.config.mjs excludes it\n' "$file" >&2
    else
        result=$(unique $result "$file")
    fi
done

if [ -z "$result" ]; then
    printf 'the area is empty: the diff leaves no source under src/ to mutate\n' >&2
    exit 0
fi
printf '%s\n' "$result"
