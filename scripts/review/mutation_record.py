"""Decides whether the last mutation run record in a PR replaces the reviewer's own run.

`make mutation` writes a run record (test/mutation-record.ts writes it, the format is in
docs/architecture/testing.md, "The run record"), the author publishes it in the PR, and a review
gate `mutation` or `mutation-full` may take it instead of running the target itself (the
pr-light-check skill). The reviewer's record of an earlier round lies in the same thread and is
taken on a par with the author's: the account is the same, and the two cannot be told apart.

The record is the last comment of the PR that starts with the marker `<!-- mutation-record ` and
was written by the account gh works as (`gh api user`). The wrapper always writes the marker as the
first line, while a quote of it in a discussion would otherwise pass for a run. The author and the
reviewer publish from that one account, and the repository is public: a marker any other account
can type, and without the check a stranger's comment would stand in for a run that never happened.

It is accepted when all four conditions hold:

1. The record covers the PR head. Its `head=` equals the PR head. A head that is not a commit of
   this repository (a force-push lost it, or git on the host did not answer and the record says
   `unknown`) leaves nothing to compare with, and the record is refused. `git rev-parse --verify
   --quiet` tells a missing commit (exit code 1) from a git that did not run. When the heads differ,
   whether the record still holds is a pass of the table in docs/agents/review-gates.md ("Changes
   that affect the mutation run") over the files changed between the two commits, and that table is
   prose, not copied here: the action lists the files and leaves the pass to the reviewer, as
   /review-pr applies the same table to the PR diff. The names do not decide every row: a `.ts`
   whose diff changes only comments leaves `mutation` off, and the reviewer reads its hunk by the
   command printed under the list. The list is `git diff --no-renames --name-only <record head>
   <PR head>`: between the trees and not from the merge-base, because
   after a rebase the record's head is no longer an ancestor and a diff from the merge-base would
   add the branch's own changes; `--no-renames` because rename detection prints only the new path
   of a move, and the old one (a spec moved out of test/, a renamed tool of the run) matters to the
   table as much.
2. `clean=yes`: a run on a dirty tree checked something other than the commit.
3. The run reached the report and its area is the gate's:
   - `score` is not `none`: without the report there are no mutants to judge by.
   - The scope matches the gate: `scope=full` under `mutation-full`, `scope=files` under
     `mutation`. A full record is not taken under `mutation` although its area covers: the outcome
     is the exit code of the whole run, so a survivor in a file the PR did not touch would paint
     the gate red, and an area without mutants would give `ok` instead of `n-a`. The reviewer's own
     run of the area takes seconds.
   - Under `mutation`, every file of the area is in the record, among the mutated files or as a
     path in `files`. The second counts because a file without a single mutant never gets into the
     Stryker report: a file of types alone is visible in the record only as a named path. A file
     that got into the run through a glob and has no mutants is visible nowhere, and the record is
     refused.
   - The list of survivors is not cut off by the wrapper's `…and N more` line: the rest lies only on
     the machine of the run, and a red gate is repeated on every file with survivors.
4. The `rebuild` gate is off: the author's run may have gone on an old image.

The answer goes to stdout, and its first line is one of three:

- `accepted <link>`: then the record's `exit`, `score` and survivors, from which the reviewer
  writes the gate's line; a red record still goes to the per-file repeat.
- `accepted if the table turns on none of …: <link>`: the other conditions hold and the
  trees of the two heads differ; the changed files follow. Heads that differ over the same tree (a
  rebase with nothing to replay, a re-push) change no file, and the answer is plain `accepted`:
  its `head:` line then says `not the PR head`.
- `refused: <link>` (or `refused: no record in the PR`): every reason at once, one per line, so
  that one reading shows all that is wrong. When the trees of the heads differ, the changed files
  follow the reasons as they do in the conditional answer, and they are not a reason: whether they
  stale the record is the table's.

A refused record is not a review finding: a process error must not cost a round. A failed `gh` or
`git` is `Stopped:` on stderr with a non-zero exit code and never a refusal: the record was not
checked, and the reviewer has to say so.
"""

import json
import re
import subprocess
import sys
from typing import List, NamedTuple, Optional, Tuple

from tree_remove import Run, reason

PR_NUMBER = re.compile(r"[1-9][0-9]*")
GATES = ("mutation", "mutation-full")
SCOPES = {"mutation": "files", "mutation-full": "full"}
# The gates of the table that stale a record (docs/agents/review-gates.md, "Changes that affect the
# mutation run"). The names only: which files turn them on is the table's.
STALING = "rebuild, mutation, mutation-full"

PREFIX = "<!-- mutation-record "
MARKER = re.compile(
    r"<!-- mutation-record head=(?P<head>\S+) clean=(?P<clean>\S+) scope=(?P<scope>\S+) "
    r"exit=(?P<exit>\S+) score=(?P<score>\S+) -->"
)
FILES = re.compile(r"- files: `(?P<files>[^`]*)`")
MUTATED = re.compile(r"<details><summary>Mutated files: \d+</summary>")
SURVIVORS = re.compile(r"### Survived and uncovered: \d+")
CUT_OFF = re.compile(r"- …and \d+ more")


class Stop(Exception):
    pass


class Record(NamedTuple):
    url: str
    head: str
    clean: str
    scope: str
    exit: str
    score: str
    # The paths of `files` (empty when the whole of src/ was mutated) and of the mutated files.
    files: List[str]
    mutated: List[str]
    survivors: List[str]


def check(done: "subprocess.CompletedProcess[str]", what: str) -> None:
    if done.returncode != 0:
        raise Stop("{} — {}".format(what, reason(done)))


def parse(url: str, body: str) -> Optional[Record]:
    """The record of a comment body, or None when its marker is not the wrapper's."""
    lines = body.splitlines()
    marker = MARKER.fullmatch(lines[0].strip())
    if marker is None:
        return None
    files: List[str] = []
    mutated: List[str] = []
    survivors: List[str] = []
    section = ""
    for line in lines[1:]:
        found = FILES.fullmatch(line)
        if found:
            files = found.group("files").split()
        elif MUTATED.fullmatch(line):
            section = "mutated"
        elif SURVIVORS.fullmatch(line):
            section = "survivors"
        elif section == "mutated":
            # The list stands in a ```text block inside <details>: the fences and the blank lines
            # around it are not paths.
            if line == "</details>":
                section = ""
            elif line and not line.startswith("```"):
                mutated.append(line)
        elif section == "survivors" and line.startswith("- "):
            survivors.append(line)
    return Record(url, files=files, mutated=mutated, survivors=survivors, **marker.groupdict())


def viewer(run: Run) -> str:
    done = run(["gh", "api", "user", "-q", ".login"], capture_output=True, text=True)
    check(done, "gh api user failed")
    login = done.stdout.strip()
    if not login:
        raise Stop("gh api user named no login")
    return login


def last_record(pr: str, run: Run) -> Tuple[str, Optional[dict]]:
    """The PR head and the last comment of the viewer that starts with the marker."""
    login = viewer(run)
    done = run(
        ["gh", "pr", "view", pr, "--json", "headRefOid,comments"],
        capture_output=True,
        text=True,
    )
    check(done, "gh pr view {} failed".format(pr))
    try:
        view = json.loads(done.stdout)
        head = view["headRefOid"]
        comments = [
            c
            for c in view["comments"]
            if c["body"].startswith(PREFIX) and (c["author"] or {}).get("login") == login
        ]
    except (ValueError, KeyError, TypeError) as failure:
        raise Stop("gh pr view {} gave no head and comments — {}".format(pr, failure))
    if not head:
        raise Stop("gh pr view {} named no head".format(pr))
    return head, comments[-1] if comments else None


def is_commit(head: str, run: Run) -> bool:
    done = run(
        ["git", "rev-parse", "--verify", "--quiet", head + "^{commit}"],
        capture_output=True,
        text=True,
    )
    if done.returncode == 1:
        return False
    check(done, "git rev-parse {} failed".format(head))
    return True


def changed_between(old: str, new: str, run: Run) -> List[str]:
    done = run(
        ["git", "diff", "--no-renames", "--name-only", old, new],
        capture_output=True,
        text=True,
    )
    check(done, "git diff {} {} failed".format(old, new))
    return [line for line in done.stdout.splitlines() if line]


def reasons_against(
    record: Record, gate: str, area: List[str], rebuild: bool
) -> List[str]:
    """Conditions 2-4; condition 1 needs git and is decided by the caller."""
    reasons = []
    if record.clean != "yes":
        reasons.append(
            "clean={}: the run did not go on a clean tree of its commit".format(record.clean)
        )
    if record.score == "none":
        reasons.append("score=none: the run broke off before the report")
    if record.scope != SCOPES[gate]:
        reasons.append(
            "scope={} under the {} gate: the record's area is not the gate's".format(
                record.scope, gate
            )
        )
    if gate == "mutation":
        seen = set(record.files) | set(record.mutated)
        missing = [file for file in area if file not in seen]
        if missing:
            reasons.append(
                "the record has neither among the mutated files nor in files: {}".format(
                    " ".join(missing)
                )
            )
    if any(CUT_OFF.match(line) for line in record.survivors):
        reasons.append(
            "the list of survivors is cut off: the rest lies only on the machine of the run"
        )
    if rebuild:
        reasons.append("the rebuild gate is on: the run may have gone on an old image")
    return reasons


def print_changed(old: str, new: str, changed: List[str]) -> None:
    print("changed between the record's head {} and the PR head {}:".format(old, new))
    for file in changed:
        print("  " + file)
    print("the hunk of a file: git diff {} {} -- <file>".format(old, new))


def print_run(record: Record, pr_head: str) -> None:
    if record.head == pr_head:
        same = "the PR head"
    else:
        same = "not the PR head {}".format(pr_head)
    print("head: {} — {}".format(record.head, same))
    print("exit: {}".format(record.exit))
    print("score: {}".format(record.score))
    print("survivors: {}".format(len(record.survivors)))
    for line in record.survivors:
        print(line)


def mutation_record(
    pr: str, gate: str, area: List[str], rebuild: bool, run: Run = subprocess.run
) -> int:
    try:
        pr_head, comment = last_record(pr, run)
        if comment is None:
            print("refused: no record in the PR")
            return 0
        record = parse(comment["url"], comment["body"])
        if record is None:
            print("refused: {}".format(comment["url"]))
            print("- the marker is not the wrapper's: {}".format(comment["body"].splitlines()[0]))
            return 0
        reasons = reasons_against(record, gate, area, rebuild)
        changed: Optional[List[str]] = None
        if record.head != pr_head:
            if record.head == "unknown" or not is_commit(record.head, run):
                reasons.insert(
                    0,
                    "head={}: not a commit of this repository, nothing to compare the PR head "
                    "{} with".format(record.head, pr_head),
                )
            else:
                changed = changed_between(record.head, pr_head, run)
    except Stop as stop:
        print("Stopped: {}".format(stop), file=sys.stderr)
        return 1

    if reasons:
        print("refused: {}".format(record.url))
        for line in reasons:
            print("- " + line)
        if changed:
            print_changed(record.head, pr_head, changed)
        return 0

    if changed:
        print("accepted if the table turns on none of {}: {}".format(STALING, record.url))
        print_changed(record.head, pr_head, changed)
    else:
        print("accepted {}".format(record.url))
    print_run(record, pr_head)
    return 0


USAGE = (
    "usage: make mutation-record pr=<N> gate=mutation|mutation-full "
    '[area="<paths>"] [rebuild=1]\n'
    "area is required under mutation and not taken under mutation-full"
)


def main(argv: Optional[List[str]] = None) -> int:
    # The make target passes all four in a fixed order, the empty ones as empty strings.
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 4:
        print(USAGE, file=sys.stderr)
        return 2
    pr, gate, area, rebuild = args[0], args[1], args[2].split(), args[3]
    if (
        not PR_NUMBER.fullmatch(pr)
        or gate not in GATES
        or bool(area) != (gate == "mutation")
        or rebuild not in ("", "1")
    ):
        print(USAGE, file=sys.stderr)
        return 2
    return mutation_record(pr, gate, area, rebuild == "1")


if __name__ == "__main__":
    sys.exit(main())
