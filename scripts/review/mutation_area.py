"""Assembles the area of `make mutation files=…` from the files a change touched.

The `mutation` gate of PR review (the pr-light-check skill) and the author's run before a push
(.claude/commands/solve-issue.md) mutate the same area and differ only in where the changed files
come from: `gh pr diff <N> --name-only` in the tree of the PR for the reviewer, `git diff
--name-only origin/main...HEAD` for the author. The rule runs in the tree given as `tree`, or in
the current one without it:

- A `.ts` whose diff changes only comments gives no area, whatever its kind: the run's outcome
  does not depend on it (below).
- A source `src/**/*.ts` goes into the area as it is.
- A spec gives its mirror (`test/a/b.spec.ts` -> `src/a/b.ts`). A change that weakened a spec
  touches no source, and without the mirror it would have nothing to mutate.
- Any other `.ts` under `test/` is a helper. The files importing it through the alias of the test
  code are found: specs give their mirrors, helpers are searched the same way until nothing new is
  left. The mocha hooks are imported by nobody and give no area.
- Only the files of the tree are kept. A diff also names deleted files and the old paths of moves
  (PR #366). `git ls-files` is run once with no paths and the list is filtered here: with an empty
  list of paths `git ls-files --` prints every file of the repository instead of nothing.
- A spec whose mirror is not in the tree gets its source by file name. The mirror is a rule, not a
  list: the specs of `test/font-convertor/` lie flat while the sources are laid out in directories
  (the spec paths in docs/architecture/README.md, "Directory map"). Found by neither — the spec
  gives no area.
- The exclusions of the mutation run are subtracted. The Stryker config excludes those files
  itself, but an area made of them alone passes its check of the `files` globs and gives a run
  without a single mutant.

No list of the configs is copied here: the exclusions (the `!` entries of `mutate` in the
evaluated stryker.config.mjs), the spec glob (`.mocharc.json` is JSONC and is read by mocha's own
loader, not as text) and the alias of the test code (`paths` of tsconfig.check.json) come from
mutation-area-configs.mjs, run by `node` in the application container through `DC_APP_RUN` of the
Makefile, so they are exactly what Stryker, mocha and tsc see.

The reviewer calls the action from the tree the review started in (the pr-light-check skill says
why) and names the tree of the PR as `tree`. Everything that reads the PR's files runs in `tree`:
`git` for the diff, the file list and the importers, and the container that reads the configs,
since Compose resolves `docker-compose.app.yml` and the mounts from the directory it is run in.
Called from another tree without `tree`, the action would check the files and read the configs of
that tree: a source the PR adds would be left out as "not in the tree".

Comments only is the rule of docs/agents/review-gates.md, the paragraph on the comments-only `.ts`
diff, applied here file by file: the table decides whether the gate is on, and the action which
files of the diff give the area. Only a tool directive changes the status of a mutant: the
`// Stryker disable` mark that silences a survivor, or a `@ts-` comment of a source or a spec, by
which the type checker decides who gets `CompileError`. A reworded comment in a helper would
otherwise mutate the mirrors of every spec importing it. The two versions are the blobs of `git diff --raw origin/main...HEAD` in the tree, the same
range the author's candidates come from; a file this diff does not show as modified in place with
its mode kept (added, deleted, renamed, a mode changed) is code. mutation-area-comments.mjs compares
them in the application container by the syntax tree of the TypeScript parser, and its header says
why not by the tokens of the text. Which of the comments is a directive is decided here (DIRECTIVE):
a directive added, removed, reworded or moved to another token keeps the file in the area.

The area goes to stdout one path per line; why a file was left out goes to stderr, so an empty area
still says why it is empty. A failed `git`, `gh` or container run is an error with a non-zero exit
code and never an empty area: an empty area reads as "nothing to check".
"""

import json
import os
import re
import shlex
import subprocess
import sys
from typing import Dict, List, NamedTuple, Optional, Set

from tree_remove import Run, reason

PR_NUMBER = re.compile(r"[1-9][0-9]*")

# The configs are read by a node script in the application container (its header says why it goes
# on stdin rather than by path).
CONFIGS_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "mutation-area-configs.mjs"
)
COMMENTS_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "mutation-area-comments.mjs"
)
# A comment a tool reads rather than a person: it opens with `///`, with `@` or with the name of a
# tool (docs/agents/review-gates.md, the paragraph on the comments-only `.ts` diff).
DIRECTIVE = re.compile(r"///|(?://|/\*+)[\s*]*(?:@|(?:stryker|eslint|istanbul|prettier)\b)", re.I)


class Stop(Exception):
    pass


class Configs(NamedTuple):
    excluded: Set[str]
    specs: Set[str]
    # (specifier prefix, directory) pairs of the wildcard entries of `paths`: ("test/", "test/").
    aliases: List[List[str]]


def check(done: "subprocess.CompletedProcess[str]", what: str) -> None:
    if done.returncode != 0:
        raise Stop("{} — {}".format(what, reason(done)))


def changed_files(pr: Optional[str], tree: Optional[str], run: Run) -> List[str]:
    if pr is None:
        command = ["git", "diff", "--name-only", "origin/main...HEAD"]
    else:
        command = ["gh", "pr", "diff", pr, "--name-only"]
    done = run(command, cwd=tree, capture_output=True, text=True)
    check(done, "{} failed".format(" ".join(command)))
    return [line for line in done.stdout.splitlines() if line]


def tracked_files(tree: Optional[str], run: Run) -> Set[str]:
    done = run(["git", "ls-files"], cwd=tree, capture_output=True, text=True)
    check(done, "git ls-files failed")
    return set(done.stdout.splitlines())


def comments_only_files(
    changed: List[str], tree: Optional[str], dc_app_run: str, run: Run
) -> Set[str]:
    """The changed `.ts` whose diff against origin/main changes neither code nor a directive."""
    command = [
        "git", "diff", "--raw", "--no-renames", "--no-abbrev", "-z", "origin/main...HEAD", "--"
    ] + changed
    done = run(command, cwd=tree, capture_output=True, text=True)
    check(done, "git diff --raw origin/main...HEAD failed")
    # With -z every entry is ":<old mode> <new mode> <old blob> <new blob> <status>" and the path,
    # each ended by NUL.
    fields = done.stdout.split("\0")
    blobs: Dict[str, List[str]] = {}
    for meta, path in zip(fields[0::2], fields[1::2]):
        old_mode, new_mode, old, new, status = meta.lstrip(":").split()
        # An added, deleted or renamed `.ts`, or one whose mode changed, is code whatever its hunks
        # hold; so is a changed file this diff does not name.
        if status == "M" and old_mode == new_mode:
            blobs[path] = [old, new]
    if not blobs:
        return set()

    versions: Dict[str, Dict[str, str]] = {}
    for path, pair in blobs.items():
        texts = []
        for blob in pair:
            shown = run(["git", "cat-file", "blob", blob], cwd=tree, capture_output=True, text=True)
            check(shown, "git cat-file blob {} of {} failed".format(blob, path))
            texts.append(shown.stdout)
        versions[path] = {"old": texts[0], "new": texts[1]}
    command = '{} node --input-type=module -e "$(cat {})"'.format(
        dc_app_run, shlex.quote(COMMENTS_SCRIPT)
    )
    done = run(
        ["sh", "-c", command], cwd=tree, input=json.dumps(versions), capture_output=True, text=True
    )
    check(done, "the comments were not compared in the application container")
    lines = [line for line in done.stdout.splitlines() if line.strip()]
    try:
        read = json.loads(lines[-1])
        return {path for path in versions if comments_only(read[path])}
    except (IndexError, ValueError, KeyError, TypeError) as failure:
        raise Stop("the application container compared no comments — {}".format(failure))


def comments_only(answer: dict) -> bool:
    """Whether the code is the same and every directive stands, unchanged, before the same token."""
    if answer["same"] is not True:
        return False

    def directives(comments: List[List[object]]) -> List[List[object]]:
        return [[anchor, text] for anchor, text in comments if DIRECTIVE.match(str(text))]

    return directives(answer["old"]) == directives(answer["new"])


def read_configs(changed: List[str], tree: Optional[str], dc_app_run: str, run: Run) -> Configs:
    command = "{} node --input-type=module - {} < {}".format(
        dc_app_run, " ".join(shlex.quote(path) for path in changed), shlex.quote(CONFIGS_SCRIPT)
    )
    done = run(["sh", "-c", command], cwd=tree, capture_output=True, text=True)
    check(done, "the configs were not read in the application container")
    # Compose writes its progress to stderr, but the last line is the only one the script prints.
    lines = [line for line in done.stdout.splitlines() if line.strip()]
    try:
        read = json.loads(lines[-1])
        return Configs(set(read["excluded"]), set(read["specs"]), [
            [alias["prefix"], alias["dir"]] for alias in read["aliases"]
        ])
    except (IndexError, ValueError, KeyError, TypeError) as failure:
        raise Stop("the application container answered with no configs — {}".format(failure))


def importers(helper: str, aliases: List[List[str]], tree: Optional[str], run: Run) -> List[str]:
    """The `.ts` files under test/ importing the helper through an alias of tsconfig.check.json."""
    module = helper[: -len(".ts")]
    specifiers = [
        prefix + module[len(directory) :]
        for prefix, directory in aliases
        if module.startswith(directory)
    ]
    specifiers += [
        specifier[: -len("/index")] for specifier in specifiers if specifier.endswith("/index")
    ]
    if not specifiers:
        return []
    command = ["git", "grep", "-l", "-F"]
    for specifier in specifiers:
        command += ["-e", '"{}"'.format(specifier), "-e", "'{}'".format(specifier)]
    command += ["--", "test/*.ts"]
    done = run(command, cwd=tree, capture_output=True, text=True)
    # git grep exits with 1 when nothing matched, which is an answer and not a failure.
    if done.returncode == 1 and not done.stderr.strip():
        return []
    check(done, "git grep for the importers of {} failed".format(helper))
    return [line for line in done.stdout.splitlines() if line and line != helper]


def assemble(
    changed: List[str],
    tracked: Set[str],
    configs: Configs,
    tree: Optional[str],
    run: Run,
    notes: List[str],
) -> List[str]:
    area: Set[str] = set()

    def add_source(source: str) -> None:
        if source in tracked:
            area.add(source)
        else:
            notes.append("`{}` is left out: it is not in the tree".format(source))

    def add_spec(spec: str) -> None:
        # The mirror rule of docs/architecture/README.md, "Directory map".
        mirror = "src/" + spec[len("test/") : -len(".spec.ts")] + ".ts"
        if mirror in tracked:
            area.add(mirror)
            return
        name = os.path.basename(mirror)
        by_name = sorted(
            file for file in tracked if file.startswith("src/") and os.path.basename(file) == name
        )
        if not by_name:
            notes.append(
                "`{}` gives no area: neither its mirror `{}` nor a source named `{}` is in the "
                "tree".format(spec, mirror, name)
            )
        area.update(by_name)

    helpers: List[str] = []
    for file in changed:
        if file.startswith("src/"):
            add_source(file)
        elif file in configs.specs:
            add_spec(file)
        else:
            helpers.append(file)

    searched: Set[str] = set()
    while helpers:
        helper = helpers.pop(0)
        if helper in searched:
            continue
        searched.add(helper)
        found = importers(helper, configs.aliases, tree, run)
        if not found:
            notes.append("`{}` gives no area: no file under test/ imports it".format(helper))
        for file in found:
            if file in configs.specs:
                add_spec(file)
            else:
                helpers.append(file)

    for file in sorted(area & configs.excluded):
        notes.append("`{}` is left out: the Stryker config excludes it".format(file))
    return sorted(area - configs.excluded)


def mutation_area(
    pr: Optional[str], tree: Optional[str], dc_app_run: str, run: Run = subprocess.run
) -> int:
    notes: List[str] = []
    try:
        changed = [
            file
            for file in changed_files(pr, tree, run)
            if file.endswith(".ts") and file.startswith(("src/", "test/"))
        ]
        if changed:
            skipped = comments_only_files(changed, tree, dc_app_run, run)
            for file in changed:
                if file in skipped:
                    notes.append("`{}` gives no area: its diff changes only comments".format(file))
            changed = [file for file in changed if file not in skipped]
        else:
            notes.append("the diff has no .ts under src/ or test/")
        area = []
        if changed:
            tracked = tracked_files(tree, run)
            configs = read_configs(changed, tree, dc_app_run, run)
            area = assemble(changed, tracked, configs, tree, run, notes)
    except Stop as stop:
        print("Stopped: {}".format(stop), file=sys.stderr)
        return 1

    for note in notes:
        print(note, file=sys.stderr)
    for file in area:
        print(file)
    return 0


def main(argv: Optional[List[str]] = None, environ: Optional[Dict[str, str]] = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    env = os.environ if environ is None else environ
    # The Makefile passes both arguments always, the ones not given as empty strings.
    if len(args) != 2 or (args[0] and not PR_NUMBER.fullmatch(args[0])):
        print("usage: make mutation-area [pr=<N>] [tree=<path>]", file=sys.stderr)
        return 2
    pr, tree = args[0] or None, args[1] or None
    dc_app_run = env.get("DC_APP_RUN", "")
    if not dc_app_run:
        print("Stopped: no DC_APP_RUN — run it as make mutation-area", file=sys.stderr)
        return 2
    if tree is not None and not os.path.isdir(tree):
        print("Stopped: {} is not a directory".format(tree), file=sys.stderr)
        return 2
    return mutation_area(pr, tree, dc_app_run)


if __name__ == "__main__":
    sys.exit(main())
