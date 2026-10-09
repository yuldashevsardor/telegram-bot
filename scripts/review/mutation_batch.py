"""Records an issue and its PR in a batch of the deferred mutation run, checks the record, lists the
files of the batch run, or closes the batch after its run.

Any change of code, a `.ts` in `src/` or `test/` or a tool of the mutation run, turns on the
`mutation-full` gate (docs/agents/review-gates.md): a PR runs no mutants of its own. A full
`make mutation` takes hours (item 3 of `close`), and an area run slows down under the load of
parallel sessions.
Instead of paying either on every review round, the change is recorded in a batch, and the batch
run goes on fresh `main` once per `BATCH_SIZE_ISSUES` recorded issues: over the files its PRs
changed in code (`files`), or over the whole of `src/` when one of them changed a tool of the run.
A batch is an issue titled `Full mutation run <N>`, `<N>` a plain increment from 1; at most one
batch is open at a time. No label marks it: docs/agents/issue-tracker.md forbids new ones.

`record <issue> <pr>` (make mutation-full-record):

1. Takes an exclusive `fcntl.flock` on a file in the common git directory, so the sessions of every
   worktree of this machine go one at a time. Cloud sessions do not share the file and are not
   covered.
2. Lists the batches: the issues the viewer (`gh api user`) created, through the REST listing of the
   repository's issues, with the title matched here. Not `gh issue list --search`: the search index
   lags and misses a batch a neighbour created a second ago. Not a `--limit`ed `gh issue list`: the
   newest batch would drop out of it silently once enough issues came after it.
3. No open batch — creates `Full mutation run <max N + 1>` from templates/mutation-batch.md. Two
   open batches — stops: which one the record belongs to is a human's call.
4. The issue is already recorded in the open batch with this PR — changes nothing, so a repeat call
   or the next review round does not count twice. With another PR it is recorded again: a PR that
   replaces one closed without a merge needs a record of its own for `close` to sort, while the
   threshold counts the issue once.
5. Otherwise adds a comment from templates/mutation-batch-record.md. A record is a comment and not
   an edit of the batch body: an edit is read-modify-write, and of two concurrent edits one is lost
   silently.
6. At `BATCH_SIZE_ISSUES` recorded issues or more prints that the threshold is reached.

`check <pr>` (make mutation-full-check) writes nothing and takes no lock. It takes the issues the PR
closes (`closingIssuesReferences`, the `Closes #N` of its body) and answers whether one of them is
recorded together with this PR in a batch, open or closed. A record of the issue with another PR
does not count: `close` sorts PRs, and a PR without a record of its own would be in none of its
lists.

`files <batch>` (make mutation-batch-files, and make mutation batch=<N> through it) writes nothing
and takes no lock:

1. Sorts the PRs recorded in the batch as `close` does (item 5 there) against `HEAD`, the commit the
   run is about to test. One closed without a merge is skipped; one not merged, or merged after
   `HEAD`, is left to the carry-over of `close`.
2. Reads the change of each merged PR off its merge commit, against the first parent: the change
   the PR brought into `main`, renames followed. A merge commit with one parent is a squash or a
   rebase merge, and the latter names the last commit of the PR only. A file the REST listing of
   the PR's files names that the commit does not change (an earlier commit of a rebase, or a squash
   of a change `main` already had) has no old text to compare with, and counts as changed in code.
   A spec gone from the commit is read at the first parent of the commit that deleted it, found
   along the first parents. The listing stops at 3000 files: a PR past that leaves the rest of the
   files of a rebase merge unseen.
3. A changed tool of the run (`RUN_TOOLS`, and `RUN_TOOLS_BY_CONTENT` by what of them the run reads,
   as docs/agents/review-gates.md says) in more than comments sends the batch to the full run:
   stdout stays empty, and stderr names the PR and the file.
4. Otherwise keeps each `.ts` in `src/` or `test/` the PR added, renamed or changed in more than
   comments, by the rules of docs/agents/review-gates.md, "Comments-only diffs" (`Scanner` and
   `is_comments_only` below), and each spec or spec helper it deleted. A file the scanner cannot
   read counts as code.
5. A kept file of `test/` stands for the files of `src/` it imports through `app/*`, itself and
   through the helpers it imports through `test/*`, read at the merge commit, or at its parent for
   a deleted one. A spec that a changed helper serves is not followed.
6. Takes each file of `src/` under its name at `HEAD`, following the renames of `main` commit by
   commit along the first parents, and drops the ones no longer there.
7. Prints the files on one line for `MUTATE`, and on stderr where each one comes from. When no file
   is left the batch takes the full run too, so it still has a record to close on; when no PR of the
   batch is merged into `HEAD` yet, the action stops.

`close <batch> <issues>` (make mutation-full-close) closes a batch after its run, under the same
lock as `record`:

1. The batch is the viewer's issue `Full mutation run <N>` by its number, open or closed: the PR
   that fixes the survivors closes it through `Closes #<batch>` on its merge. When the batch
   already carries its closing comment, only closing the issue is left, so a repeat call after a
   stop finishes the job, posts nothing twice and reads no run record: by then the record may be
   gone together with the worktree of the run.
2. Reads the record of the batch run, reports/mutation/batch-record.md
   (docs/architecture/testing.md, "The run record"), and stops unless `make mutation batch=<N>` ran
   it for this batch on a clean tree and it left a report with a score. A score of NaN closes a run
   over files: its files hold nothing a test could kill (types alone, files stryker.config.mjs
   excludes, or mutants that are all errors or silenced by a mark); over the whole of `src/` it
   stops.
3. Reads the record of the last run, reports/mutation/record.md. When it is of a run over files of
   no batch, it is the check of the fixed survivors: it has to be green, on a clean tree, on a
   descendant of the head of the batch run. Which files each round of fixes runs over is step 2 of
   "A batch as the issue" in .claude/commands/solve-issue.md; the record holds the last round, and
   the earlier rounds and their survivors are the caller's check. The batch run is not repeated for
   the fixes: in batch 1 (#701) its full run took about 190 minutes, not counting 7.5 hours the
   machine slept, while the run over the files of its survivors took 43. A run over files on the
   head of the batch run checked no fix and stops the close.
4. A red batch run (`exit` other than 0) closes only with the issues filed for its survivors named,
   or with the run over files of item 3, or both. A red run over files stops the close even with
   issues named: it is the last round of fixes, and a survivor left to an issue carries a mark
   linking to it, so it does not paint the run red. Whether the issues and the runs cover every
   survivor is the caller's check. A green batch run has no survivors to fix, and the record of the
   last run is not read for it.
5. Sorts each recorded PR by `gh pr view`: merged, with its merge commit an ancestor of the head of
   the batch run — covered; merged later, or not merged — carried over; closed without a merge —
   dropped. A PR recorded after `files` listed the batch counts as covered too, though the run did
   not mutate its files: it takes a PR merged without a record, which `mutation-full-check` in
   review stops.
6. Records the carried ones into the other open batch, created if there is none, from
   templates/mutation-batch-carry.md. An issue already recorded there with the same PR is not
   recorded twice.
7. Comments from templates/mutation-batch-close.md, then closes the issue if it is open.

A batch, a record or a closing comment counts only when the viewer wrote it, and a comment only by
its marker, the first line of its template. The repository is public: anyone can type the title or
the marker, and without the check a stranger's issue would take the place of the batch. The agent
and the owner post from one account, so the viewer is both.

The answer goes to stdout. A failed `gh` or `git` is `Stopped:` on stderr with exit code 1: nothing
was decided, and the caller has to say so. After a stop in the middle of `record` a new batch may
already exist without the record; the repeat call finds it open and records into it. After a stop in
the middle of `close` the next batch may already be open next to the batch being closed; the repeat
call takes it for the next one. Until that call, two batches are open, and every `record` stops with
"more than one batch is open".
"""

import difflib
import fcntl
import json
import os
import re
import subprocess
import sys
from typing import Callable, Dict, List, NamedTuple, Optional, Set, Tuple

from tree_remove import Run, reason

BATCH_SIZE_ISSUES = 20
NUMBER = re.compile(r"[1-9][0-9]*")
BATCH_TITLE = re.compile(r"Full mutation run (?P<n>[1-9][0-9]*)")
RECORD_MARKER = re.compile(
    r"<!-- mutation-batch-record issue=(?P<issue>[1-9][0-9]*) pr=(?P<pr>[1-9][0-9]*) -->"
)
CLOSE_MARKER = re.compile(r"<!-- mutation-batch-close head=[0-9a-f]{40} -->")
# The first line of the run record test/mutation-run.ts writes.
RUN_RECORD_MARKER = re.compile(
    r"<!-- mutation-run head=(?P<head>\S+) clean=(?P<clean>\S+) scope=(?P<scope>\S+)"
    r" batch=(?P<batch>\S+) exit=(?P<exit>\S+) score=(?P<score>\S+) -->"
)
SHA = re.compile(r"[0-9a-f]{40}")
# `gh issue create` prints the URL of the issue it made; the URL ends in the issue number.
CREATED_ISSUE = re.compile(r"/issues/(?P<number>[1-9][0-9]*)\s*$")
LOCK_FILE_NAME = "mutation-batch.lock"
# Relative to the root of the worktree: the make target runs there, and so did the run. The record
# of the last run, and the one of the last batch run, which any other run leaves alone.
RUN_RECORD_FILE = os.path.join("reports", "mutation", "record.md")
BATCH_RUN_RECORD_FILE = os.path.join("reports", "mutation", "batch-record.md")
TEMPLATES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")
NO_BATCH = "none"
NOT_MERGED = "not merged"
MERGED_AFTER_HEAD = "merged after the run's head"


class Stop(Exception):
    pass


Report = Callable[[str], None]


class Batch(NamedTuple):
    issue: int
    n: int
    is_open: bool
    url: str


class Record(NamedTuple):
    issue: int
    pr: int
    url: str


class Comment(NamedTuple):
    first_line: str
    url: str


class RunRecord(NamedTuple):
    head: str
    scope: str
    batch: str
    exit: str
    score: str
    text: str


class Carried(NamedTuple):
    record: Record
    why: str


class Sorted(NamedTuple):
    covered: List[Record]
    carried: List[Carried]
    dropped: List[Record]


def check(done: "subprocess.CompletedProcess[str]", what: str) -> None:
    if done.returncode != 0:
        raise Stop("{} — {}".format(what, reason(done)))


def template(name: str, **values: object) -> str:
    with open(os.path.join(TEMPLATES, name), encoding="utf-8") as file:
        return file.read().format(**values)


def viewer(run: Run) -> str:
    done = run(["gh", "api", "user", "-q", ".login"], capture_output=True, text=True)
    check(done, "gh api user failed")
    login = done.stdout.strip()
    if not login:
        raise Stop("gh api user named no login")
    return login


def list_batches(login: str, run: Run) -> List[Batch]:
    """Every batch the viewer created, open and closed."""
    done = run(
        [
            "gh",
            "api",
            "--paginate",
            "repos/{owner}/{repo}/issues?state=all&per_page=100&creator=" + login,
            # The listing holds the PRs as well; `@json` prints one issue per line.
            "-q",
            ".[] | select(.pull_request == null) | {number, state, title, html_url} | @json",
        ],
        capture_output=True,
        text=True,
    )
    check(done, "gh api of the issues failed")
    batches = []
    try:
        for line in done.stdout.splitlines():
            if not line.strip():
                continue
            issue = json.loads(line)
            title = BATCH_TITLE.fullmatch(issue["title"])
            if title is None:
                continue
            is_open = issue["state"] == "open"
            n = int(title.group("n"))
            batches.append(Batch(issue["number"], n, is_open, issue["html_url"]))
    except (ValueError, KeyError, TypeError) as failure:
        raise Stop("gh api of the issues gave no issues — {}".format(failure))
    return batches


def list_comments(batch: Batch, login: str, run: Run) -> List[Comment]:
    """The first lines of the viewer's comments on the batch, in their order."""
    done = run(
        ["gh", "issue", "view", str(batch.issue), "--json", "comments"],
        capture_output=True,
        text=True,
    )
    check(done, "gh issue view {} failed".format(batch.issue))
    comments = []
    try:
        for comment in json.loads(done.stdout)["comments"]:
            if (comment["author"] or {}).get("login") != login:
                continue
            first_line = comment["body"].split("\n", 1)[0].strip()
            comments.append(Comment(first_line, comment["url"]))
    except (ValueError, KeyError, TypeError) as failure:
        raise Stop("gh issue view {} gave no comments — {}".format(batch.issue, failure))
    return comments


def records_among(comments: List[Comment]) -> List[Record]:
    records = []
    for comment in comments:
        marker = RECORD_MARKER.fullmatch(comment.first_line)
        if marker is None:
            continue
        issue, pr = int(marker.group("issue")), int(marker.group("pr"))
        records.append(Record(issue, pr, comment.url))
    return records


def list_records(batch: Batch, login: str, run: Run) -> List[Record]:
    """The records among the batch's comments, in their order."""
    return records_among(list_comments(batch, login, run))


def open_batch(batches: List[Batch]) -> Optional[Batch]:
    opened = [batch for batch in batches if batch.is_open]
    if len(opened) > 1:
        raise Stop(
            "more than one batch is open: {}".format(" ".join(batch.url for batch in opened))
        )
    return opened[0] if opened else None


def create_batch(batches: List[Batch], run: Run) -> Batch:
    n = max((batch.n for batch in batches), default=0) + 1
    title = "Full mutation run {}".format(n)
    body = template("mutation-batch.md", threshold=BATCH_SIZE_ISSUES)
    done = run(
        ["gh", "issue", "create", "--title", title, "--body-file", "-"],
        input=body,
        capture_output=True,
        text=True,
    )
    check(done, "gh issue create failed")
    url = done.stdout.strip()
    created = CREATED_ISSUE.search(url)
    if created is None:
        raise Stop("gh issue create named no issue: {}".format(url or "no output"))
    return Batch(int(created.group("number")), n, True, url)


def add_comment(batch: Batch, body: str, run: Run) -> str:
    """Comments on the batch; the URL of the comment."""
    done = run(
        ["gh", "issue", "comment", str(batch.issue), "--body-file", "-"],
        input=body,
        capture_output=True,
        text=True,
    )
    check(done, "gh issue comment {} failed".format(batch.issue))
    return done.stdout.strip()


def add_record(batch: Batch, issue: int, pr: int, run: Run) -> str:
    """Comments the record on the batch; the URL of the comment."""
    return add_comment(batch, template("mutation-batch-record.md", issue=issue, pr=pr), run)


def lock_path(run: Run) -> str:
    done = run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        capture_output=True,
        text=True,
    )
    check(done, "git rev-parse --git-common-dir failed")
    return os.path.join(done.stdout.strip(), LOCK_FILE_NAME)


def record_locked(issue: int, pr: int, run: Run) -> None:
    login = viewer(run)
    batches = list_batches(login, run)
    batch = open_batch(batches)
    records: List[Record] = []
    if batch is None:
        batch = create_batch(batches, run)
        print("created: {}".format(batch.url))
    else:
        records = list_records(batch, login, run)
    earlier = [record for record in records if (record.issue, record.pr) == (issue, pr)]
    if earlier:
        print("already recorded: issue #{}, PR #{} — {}".format(issue, pr, earlier[0].url))
    else:
        url = add_record(batch, issue, pr, run)
        records.append(Record(issue, pr, url))
        print("recorded: issue #{}, PR #{} — {}".format(issue, pr, url))
    recorded_issues = len({record.issue for record in records})
    print(
        "issues in the batch: {} of {} — {}".format(recorded_issues, BATCH_SIZE_ISSUES, batch.url)
    )
    if recorded_issues >= BATCH_SIZE_ISSUES:
        print("threshold reached: the batch is due for its run")


def locked(action: Callable[[], None], run: Run) -> int:
    """Runs the action under the lock of the batches; the exit code."""
    try:
        path = lock_path(run)
        # The lock is released when the file is closed, a crash included: the kernel holds it,
        # not the file.
        with open(path, "a", encoding="utf-8") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            action()
    except Stop as stop:
        print("Stopped: {}".format(stop), file=sys.stderr)
        return 1
    return 0


def record(issue: int, pr: int, run: Run = subprocess.run) -> int:
    return locked(lambda: record_locked(issue, pr, run), run)


def closed_issues(pr: int, run: Run) -> List[int]:
    done = run(
        ["gh", "pr", "view", str(pr), "--json", "closingIssuesReferences"],
        capture_output=True,
        text=True,
    )
    check(done, "gh pr view {} failed".format(pr))
    try:
        return [issue["number"] for issue in json.loads(done.stdout)["closingIssuesReferences"]]
    except (ValueError, KeyError, TypeError) as failure:
        raise Stop("gh pr view {} gave no closing issues — {}".format(pr, failure))


def check_record(pr: int, run: Run = subprocess.run) -> int:
    try:
        issues = closed_issues(pr, run)
        if not issues:
            print("not recorded: PR #{} closes no issue".format(pr))
            return 0
        login = viewer(run)
        for batch in list_batches(login, run):
            for found in list_records(batch, login, run):
                if found.issue in issues and found.pr == pr:
                    print("recorded: issue #{} — {}".format(found.issue, found.url))
                    return 0
    except Stop as stop:
        print("Stopped: {}".format(stop), file=sys.stderr)
        return 1
    named = ", ".join("#{}".format(issue) for issue in issues)
    print("not recorded: no batch records PR #{} with {}, the issues it closes".format(pr, named))
    return 0


def read_record_file(path: str) -> Optional[str]:
    """The text of a run record, None when there is no file."""
    try:
        with open(path, encoding="utf-8") as file:
            return file.read()
    except FileNotFoundError:
        return None
    except OSError as failure:
        raise Stop("the run record {} was not read — {}".format(path, failure))


def parse_run_record(path: str, text: str) -> RunRecord:
    """The record of a run that tested a commit."""
    marker = RUN_RECORD_MARKER.fullmatch(text.split("\n", 1)[0].strip())
    if marker is None:
        raise Stop("{} does not open with the marker of a run record".format(path))
    if marker.group("clean") != "yes" or not SHA.fullmatch(marker.group("head")):
        raise Stop(
            "the run record {} ties the run to no commit: clean={}, head={}".format(
                path, marker.group("clean"), marker.group("head")
            )
        )
    if marker.group("score") == "none":
        raise Stop(
            "the run of {} broke off before its report: the record has no score".format(path)
        )
    return RunRecord(
        marker.group("head"),
        marker.group("scope"),
        marker.group("batch"),
        marker.group("exit"),
        marker.group("score"),
        text,
    )


def stop_on_no_mutant(path: str, record: RunRecord) -> None:
    # A score of NaN is a run without a single valid mutant, a broken `mutate` glob say: it tested
    # nothing, and exits with 0 all the same (docs/architecture/testing.md, "Threshold").
    if record.score == "NaN":
        raise Stop("the run of {} counted no mutant: score=NaN".format(path))


def read_batch_run(path: str, batch_issue: int) -> RunRecord:
    text = read_record_file(path)
    if text is None:
        raise Stop(
            "no run record at {}: the batch run goes first, make mutation batch={}".format(
                path, batch_issue
            )
        )
    batch_run = parse_run_record(path, text)
    if batch_run.batch != str(batch_issue):
        raise Stop(
            "the run record {} is of batch={}, not of #{}".format(
                path, batch_run.batch, batch_issue
            )
        )
    # The files of a batch come from the PRs and exist on the head, so a run over them without a
    # valid mutant found nothing a test could kill in them: types alone, files stryker.config.mjs
    # excludes, or mutants that are all CompileError, RuntimeError or Ignored.
    if batch_run.scope == "full":
        stop_on_no_mutant(path, batch_run)
    return batch_run


def read_fix_run(path: str, batch_run: RunRecord, run: Run) -> Optional[RunRecord]:
    """The run over the files of the survivors after the batch run; None when there is no record
    of the last run or that run is not over files of no batch."""
    text = read_record_file(path)
    if text is None:
        return None
    fix_run = parse_run_record(path, text)
    if fix_run.scope == "full" or fix_run.batch != NO_BATCH:
        return None
    stop_on_no_mutant(path, fix_run)
    if fix_run.exit != "0":
        raise Stop(
            "the run over files of {} is red (exit={}): its survivors are not fixed".format(
                path, fix_run.exit
            )
        )
    if fix_run.head == batch_run.head:
        raise Stop(
            "the run over files is on {}, the head of the batch run: it checked no fix".format(
                fix_run.head
            )
        )
    if not is_ancestor(batch_run.head, fix_run.head, run):
        raise Stop(
            "the run over files on {} does not follow the batch run on {}".format(
                fix_run.head, batch_run.head
            )
        )
    return fix_run


def pr_state(pr: int, run: Run) -> Tuple[str, Optional[str]]:
    """The state of the PR and its merge commit, None unless merged."""
    done = run(
        ["gh", "pr", "view", str(pr), "--json", "state,mergeCommit"],
        capture_output=True,
        text=True,
    )
    check(done, "gh pr view {} failed".format(pr))
    try:
        answer = json.loads(done.stdout)
        state = answer["state"]
        merge_commit = (answer["mergeCommit"] or {}).get("oid")
    except (ValueError, KeyError, TypeError, AttributeError) as failure:
        raise Stop("gh pr view {} gave no state — {}".format(pr, failure))
    if state == "MERGED" and not merge_commit:
        raise Stop("gh pr view {} named no merge commit of a merged PR".format(pr))
    return state, merge_commit


def is_ancestor(commit: str, head: str, run: Run) -> bool:
    done = run(
        ["git", "merge-base", "--is-ancestor", commit, head],
        capture_output=True,
        text=True,
    )
    # 1 is the answer "not an ancestor"; any other non-zero code is a failure.
    if done.returncode == 1:
        return False
    check(done, "git merge-base --is-ancestor {} {} failed".format(commit, head))
    return True


def sort_records(records: List[Record], head: str, run: Run) -> Sorted:
    covered: List[Record] = []
    carried: List[Carried] = []
    dropped: List[Record] = []
    for found in records:
        state, merge_commit = pr_state(found.pr, run)
        if state == "CLOSED":
            dropped.append(found)
        elif state == "OPEN":
            carried.append(Carried(found, NOT_MERGED))
        elif state == "MERGED" and merge_commit and is_ancestor(merge_commit, head, run):
            covered.append(found)
        elif state == "MERGED":
            carried.append(Carried(found, MERGED_AFTER_HEAD))
        else:
            raise Stop("gh pr view {} named an unknown state: {}".format(found.pr, state))
    return Sorted(covered, carried, dropped)


def carry_over(
    closing: Batch, batches: List[Batch], carried: List[Carried], login: str, run: Run
) -> Optional[Batch]:
    """Records the carried PRs into the next batch; that batch, None when nothing is carried."""
    others = [batch for batch in batches if batch.is_open and batch.issue != closing.issue]
    if len(others) > 1:
        raise Stop(
            "more than one other batch is open: {}".format(" ".join(batch.url for batch in others))
        )
    if not carried:
        return None
    if others:
        next_batch = others[0]
        known = {
            (found.issue, found.pr): found.url for found in list_records(next_batch, login, run)
        }
    else:
        next_batch = create_batch(batches, run)
        known = {}
        print("created: {}".format(next_batch.url))
    for carry in carried:
        issue, pr = carry.record.issue, carry.record.pr
        if (issue, pr) in known:
            print("already carried: issue #{}, PR #{} — {}".format(issue, pr, known[(issue, pr)]))
            continue
        body = template(
            "mutation-batch-carry.md", issue=issue, pr=pr, batch=closing.issue, why=carry.why
        )
        url = add_comment(next_batch, body, run)
        print("carried: issue #{}, PR #{}, {} — {}".format(issue, pr, carry.why, url))
    return next_batch


def bullets(lines: List[str]) -> str:
    if not lines:
        return "- none"
    return "\n".join("- " + line for line in lines)


def closing_body(
    batch_run: RunRecord,
    fix_run: Optional[RunRecord],
    ordered: Sorted,
    next_batch: Optional[Batch],
    survivor_issues: List[int],
) -> str:
    def pair(found: Record) -> str:
        return "issue #{}, PR #{}".format(found.issue, found.pr)

    carried = ["{}, {}".format(pair(carry.record), carry.why) for carry in ordered.carried]
    fixes: List[str] = []
    fix_record = ""
    if fix_run is not None:
        fixes = ["the run on `{}`, its record after the one of the batch run".format(fix_run.head)]
        fix_record = "\n\n" + fix_run.text.rstrip("\n")
    return template(
        "mutation-batch-close.md",
        head=batch_run.head,
        covered=bullets([pair(found) for found in ordered.covered]),
        next_batch=" to #{}".format(next_batch.issue) if next_batch else "",
        carried=bullets(carried),
        dropped=bullets([pair(found) for found in ordered.dropped]),
        issues=bullets(["#{}".format(issue) for issue in survivor_issues]),
        fixes=bullets(fixes),
        run_record=batch_run.text.rstrip("\n"),
        fix_record=fix_record,
    )


def close_issue(batch: Batch, run: Run) -> None:
    if not batch.is_open:
        return
    done = run(["gh", "issue", "close", str(batch.issue)], capture_output=True, text=True)
    check(done, "gh issue close {} failed".format(batch.issue))


def fetch(run: Run) -> None:
    # A PR merged since the last fetch has its merge commit on origin only, and
    # git merge-base --is-ancestor fails on a commit it does not know.
    done = run(["git", "fetch", "--quiet", "origin"], capture_output=True, text=True)
    check(done, "git fetch origin failed")


def find_batch(batch_issue: int, batches: List[Batch], login: str) -> Batch:
    found = next((batch for batch in batches if batch.issue == batch_issue), None)
    if found is None:
        raise Stop(
            "#{} is no batch: no issue `Full mutation run <N>` of {}".format(batch_issue, login)
        )
    return found


def close_locked(
    batch_issue: int,
    survivor_issues: List[int],
    record_file: str,
    batch_record_file: str,
    run: Run,
) -> None:
    login = viewer(run)
    batches = list_batches(login, run)
    closing = find_batch(batch_issue, batches, login)
    comments = list_comments(closing, login, run)
    closed_before = [comment for comment in comments if CLOSE_MARKER.fullmatch(comment.first_line)]
    if closed_before:
        close_issue(closing, run)
        print("already closed: {}".format(closed_before[0].url))
        return
    batch_run = read_batch_run(batch_record_file, batch_issue)
    fix_run = None
    if batch_run.exit != "0":
        fix_run = read_fix_run(record_file, batch_run, run)
        if fix_run is None and not survivor_issues:
            raise Stop(
                "the run is red (exit={}): name the issues filed for its survivors, "
                'issues="<N> …", or check the fixed ones with a run over their files'.format(
                    batch_run.exit
                )
            )
    fetch(run)
    ordered = sort_records(records_among(comments), batch_run.head, run)
    for found in ordered.covered:
        print("covered: issue #{}, PR #{}".format(found.issue, found.pr))
    for found in ordered.dropped:
        print("dropped: issue #{}, PR #{}, closed without a merge".format(found.issue, found.pr))
    next_batch = carry_over(closing, batches, ordered.carried, login, run)
    body = closing_body(batch_run, fix_run, ordered, next_batch, survivor_issues)
    url = add_comment(closing, body, run)
    close_issue(closing, run)
    print("closed: {}".format(url))


def close_batch(
    batch_issue: int,
    survivor_issues: List[int],
    run: Run = subprocess.run,
    record_file: str = RUN_RECORD_FILE,
    batch_record_file: str = BATCH_RUN_RECORD_FILE,
) -> int:
    return locked(
        lambda: close_locked(batch_issue, survivor_issues, record_file, batch_record_file, run),
        run,
    )


# The files of a batch run (`files <batch>`).
#
# The tools of the run: the `mutation-full` row of docs/agents/review-gates.md, the files it names.
RUN_TOOLS = (
    "stryker.config.mjs",
    "test/stryker-mocha-hook.cjs",
    "test/mutation-run.ts",
    ".mocharc.json",
    "tsconfig.json",
    "tsconfig.check.json",
)
# The tools of the run by what of them the run reads (`tool_inputs`): the paragraphs of
# docs/agents/review-gates.md under its table that turn `mutation-full` on by the content of a diff.
RUN_TOOLS_BY_CONTENT = ("package.json", "package-lock.json", "Makefile")
# The words after which a `/` opens a regular expression and not a division.
REGEX_AFTER_WORDS = frozenset(
    "return typeof case do else in of new delete void throw instanceof yield await".split()
)
# The opening of a tool directive past the comment marks (docs/agents/review-gates.md,
# "Comments-only diffs"); `///` is told by the line comment itself.
DIRECTIVE = re.compile(r"(@|stryker|eslint|istanbul|prettier)", re.IGNORECASE)
IMPORT_FROM_ALIAS = re.compile(
    r"""\b(?:from|import)\s*\(?\s*["'](?P<alias>app|test)/(?P<module>[^"']+)["']"""
)
MAKE_REFERENCE = re.compile(r"\$[({](?P<name>[A-Za-z_][A-Za-z0-9_]*)[)}]")
LOCK_INPUT = re.compile(r"(^|/)node_modules/(typescript|@stryker-mutator/[^/]+)$")


class Unclear(Exception):
    """The scanner cannot tell code from a comment: the file counts as code."""


class Remark(NamedTuple):
    first_line: int
    last_line: int
    is_directive: bool


class Scan(NamedTuple):
    # The code of each line with the comments cut out, stripped of blanks; a line inside a string
    # or a template literal keeps its blanks and a backtick in front, so it is never empty.
    code: List[str]
    remarks: List[Remark]


class Scanner:
    """Splits JavaScript, TypeScript or JSONC into the code and the comments of each line.

    Not a parser: it knows strings, template literals with their `${…}`, regular expressions and
    comments, enough to tell a `//` in a string from a comment. Whether a `/` opens a regular
    expression it decides by the token before it; after a `}` it cannot tell a block from an object
    literal, and gives up, as on a string, a comment or a literal left open.
    """

    def __init__(self, text: str) -> None:
        self.text = text
        self.at = 0
        self.line = 0
        self.code: List[List[str]] = [[]]
        self.literal_lines: Set[int] = set()
        self.remarks: List[Remark] = []
        # For each `${` open, the depth of the braces inside it.
        self.substitutions: List[int] = []
        # The last token of the code: a punctuator or a word; "" before the first one.
        self.last = ""
        self.is_in_word = False

    def scan(self) -> Scan:
        while self.at < len(self.text):
            char = self.text[self.at]
            following = self.text[self.at + 1 : self.at + 2]
            if char == "/" and following == "/":
                self.line_comment()
            elif char == "/" and following == "*":
                self.block_comment()
            elif char == "/":
                self.slash()
            elif char in "'\"":
                self.string(char)
            elif char == "`":
                self.take(char, is_literal=True)
                self.template()
            elif char == "}" and self.substitutions and self.substitutions[-1] == 0:
                self.substitutions.pop()
                self.take(char, is_literal=True)
                self.template()
            else:
                self.code_char(char)
        if self.substitutions:
            raise Unclear("a template literal is left open")
        code = []
        for index, parts in enumerate(self.code):
            text = "".join(parts)
            code.append("`" + text if index in self.literal_lines else text.strip())
        return Scan(code, self.remarks)

    def take(self, char: str, is_literal: bool = False) -> None:
        """Moves past a character of the code."""
        self.at += 1
        if is_literal:
            self.literal_lines.add(self.line)
        if char == "\n":
            self.line += 1
            self.code.append([])
            if is_literal:
                self.literal_lines.add(self.line)
            return
        self.code[self.line].append(char)

    def code_char(self, char: str) -> None:
        is_word_char = char.isalnum() or char in "_$"
        if is_word_char:
            self.last = self.last + char if self.is_in_word else char
        elif not char.isspace():
            self.last = char
            if char == "{" and self.substitutions:
                self.substitutions[-1] += 1
            if char == "}" and self.substitutions:
                self.substitutions[-1] -= 1
        self.is_in_word = is_word_char
        self.take(char)

    def value_ends(self) -> None:
        """A string, a template or a regular expression is a value: a `/` after it divides."""
        self.last = ")"
        self.is_in_word = False

    def line_comment(self) -> None:
        end = self.text.find("\n", self.at)
        end = len(self.text) if end == -1 else end
        body = self.text[self.at + 2 : end]
        is_directive = body.startswith("/") or DIRECTIVE.match(body.strip()) is not None
        self.remarks.append(Remark(self.line, self.line, is_directive))
        self.at = end
        self.is_in_word = False

    def block_comment(self) -> None:
        end = self.text.find("*/", self.at + 2)
        if end == -1:
            raise Unclear("a block comment is left open")
        body = self.text[self.at + 2 : end]
        is_directive = any(
            DIRECTIVE.match(line.strip().lstrip("*").strip()) is not None
            for line in body.split("\n")
        )
        first_line = self.line
        self.line += body.count("\n")
        self.code.extend([] for _ in range(body.count("\n")))
        self.remarks.append(Remark(first_line, self.line, is_directive))
        self.at = end + 2
        self.is_in_word = False

    def slash(self) -> None:
        if self.last == "}":
            raise Unclear("a / after a closing brace on line {}".format(self.line + 1))
        is_division = self.last in (")", "]") or (
            (self.last[:1].isalnum() or self.last[:1] in "_$")
            and self.last not in REGEX_AFTER_WORDS
        )
        if is_division:
            self.code_char("/")
            return
        self.take("/", is_literal=True)
        is_in_class = False
        while True:
            char = self.char_or_unclear("a regular expression")
            if char == "\\":
                self.take(char, is_literal=True)
                self.take(self.char_or_unclear("a regular expression"), is_literal=True)
                continue
            self.take(char, is_literal=True)
            if char == "[":
                is_in_class = True
            elif char == "]":
                is_in_class = False
            elif char == "/" and not is_in_class:
                break
        self.value_ends()

    def string(self, quote: str) -> None:
        self.take(quote, is_literal=True)
        while True:
            char = self.char_or_unclear("a string")
            if char == "\\":
                self.take(char, is_literal=True)
                self.take(self.escaped_char("a string"), is_literal=True)
                continue
            self.take(char, is_literal=True)
            if char == quote:
                break
        self.value_ends()

    def template(self) -> None:
        """Moves past the text of a template literal up to its end or its next `${`."""
        while True:
            char = self.text[self.at] if self.at < len(self.text) else ""
            if char == "":
                raise Unclear("a template literal is left open")
            if char == "\\":
                self.take(char, is_literal=True)
                self.take(self.escaped_char("a template literal"), is_literal=True)
                continue
            if char == "$" and self.text[self.at + 1 : self.at + 2] == "{":
                self.take(char, is_literal=True)
                self.take("{", is_literal=True)
                self.substitutions.append(0)
                self.last = "{"
                self.is_in_word = False
                return
            self.take(char, is_literal=True)
            if char == "`":
                self.value_ends()
                return

    def escaped_char(self, what: str) -> str:
        """The character after a backslash of a string or a template literal, a line break too."""
        if self.at >= len(self.text):
            raise Unclear("{} is left open at the end".format(what))
        return self.text[self.at]

    def char_or_unclear(self, what: str) -> str:
        """The next character of a string or a regular expression, which a line break ends."""
        if self.at >= len(self.text) or self.text[self.at] == "\n":
            raise Unclear("{} is left open on line {}".format(what, self.line + 1))
        return self.text[self.at]


def directive_reach(scan: Scan, lines: List[str]) -> List[Tuple[str, ...]]:
    """Each directive with its lines and the line after it: a directive acts by line, so a change of
    its text, a new or a removed directive, and a line put between it and its code all show here."""
    return sorted(
        tuple(lines[remark.first_line : remark.last_line + 2])
        for remark in scan.remarks
        if remark.is_directive
    )


def is_comments_only(old_text: str, new_text: str) -> bool:
    """Whether the change of a file touches comments alone, by the rules of
    docs/agents/review-gates.md, "Comments-only diffs"."""
    try:
        old, new = Scanner(old_text).scan(), Scanner(new_text).scan()
    except Unclear:
        return False
    # Code a comment opens or closes over changes this sequence while every changed line is a
    # comment, and so does a line break that moves code onto another line.
    if [code for code in old.code if code] != [code for code in new.code if code]:
        return False
    old_lines, new_lines = old_text.split("\n"), new_text.split("\n")
    matcher = difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False)
    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        if tag == "equal":
            continue
        # The sequences of code are equal, so the old side of a change holds as many lines of code
        # as the new one.
        if any(new.code[new_start:new_end]):
            return False
    return directive_reach(old, old_lines) == directive_reach(new, new_lines)


class ChangedFile(NamedTuple):
    status: str
    old_path: str
    new_path: str


class BatchFiles(NamedTuple):
    files: List[str]
    full_run_reasons: List[str]


def git_text(args: List[str], run: Run) -> str:
    done = run(["git"] + args, capture_output=True, text=True)
    check(done, "git {} failed".format(" ".join(args)))
    return done.stdout


def changed_files(old: str, new: str, run: Run) -> List[ChangedFile]:
    """The files that differ between two commits, renames followed."""
    fields = git_text(["diff", "--name-status", "-M", "-z", old, new], run).split("\0")
    changed = []
    at = 0
    while at < len(fields) and fields[at]:
        status = fields[at][0]
        if status in "RC":
            changed.append(ChangedFile(status, fields[at + 1], fields[at + 2]))
            at += 3
        else:
            changed.append(ChangedFile(status, fields[at + 1], fields[at + 1]))
            at += 2
    return changed


def file_at(commit: str, path: str, run: Run) -> str:
    return git_text(["show", "{}:{}".format(commit, path)], run)


def package_inputs(text: str) -> object:
    """What of `package.json` the run reads: its npm script and the versions of its tools."""
    package = json.loads(text)
    versions = {}
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        for name, version in (package.get(section) or {}).items():
            if name == "typescript" or name.startswith("@stryker-mutator/"):
                versions[section + " " + name] = version
    return (package.get("scripts") or {}).get("mutation"), versions


def lock_inputs(text: str) -> object:
    packages = json.loads(text).get("packages") or {}
    return {
        path: (entry or {}).get("version")
        for path, entry in packages.items()
        if LOCK_INPUT.search(path)
    }


def make_definition(lines: List[str], name: str) -> List[str]:
    """The lines that define a variable of the Makefile, continuations and `define` included."""
    escaped = re.escape(name)
    assignment = re.compile(r"(override\s+)?{}\s*(:::=|::=|:=|\?=|\+=|!=|=)".format(escaped))
    found = []
    at = 0
    while at < len(lines):
        line = lines[at]
        if re.match(r"define\s+{}\b".format(escaped), line):
            while at < len(lines) and lines[at] != "endef":
                found.append(lines[at])
                at += 1
        elif assignment.match(line):
            found.append(line)
            while line.endswith("\\") and at + 1 < len(lines):
                at += 1
                line = lines[at]
                found.append(line)
        at += 1
    return found


def mutation_recipe(text: str) -> List[str]:
    """The rule of `make mutation`, its recipe and the variables it expands, theirs in turn."""
    lines = text.split("\n")
    rule = []
    for at, line in enumerate(lines):
        if re.match(r"mutation\s*:(?!=)", line):
            # The `##` after the prerequisites is the description `make help` prints.
            rule.append(line.split("#", 1)[0].rstrip())
            for recipe_line in lines[at + 1 :]:
                if not recipe_line.startswith("\t"):
                    break
                rule.append(recipe_line)
            break
    names = [match.group("name") for line in rule for match in MAKE_REFERENCE.finditer(line)]
    seen = set()
    while names:
        name = names.pop()
        if name in seen:
            continue
        seen.add(name)
        definition = make_definition(lines, name)
        rule.extend(definition)
        names.extend(
            match.group("name") for line in definition for match in MAKE_REFERENCE.finditer(line)
        )
    return rule


def tool_inputs(path: str, text: str) -> object:
    """What of a tool of the run the run reads: the code of the file, or a part of it."""
    if path == "package.json":
        return package_inputs(text)
    if path == "package-lock.json":
        return lock_inputs(text)
    return mutation_recipe(text)


def is_tool_changed(changed: ChangedFile, parent: str, commit: str, run: Run) -> Optional[bool]:
    """Whether the change of a file changes a tool of the run; None when the file is no tool."""
    paths = {changed.old_path, changed.new_path}
    if paths & set(RUN_TOOLS):
        if changed.status != "M":
            return True
        old_text = file_at(parent, changed.old_path, run)
        return not is_comments_only(old_text, file_at(commit, changed.new_path, run))
    for path in RUN_TOOLS_BY_CONTENT:
        if path not in paths:
            continue
        if changed.status != "M":
            return True
        try:
            old_inputs = tool_inputs(path, file_at(parent, path, run))
            new_inputs = tool_inputs(path, file_at(commit, path, run))
        except (ValueError, AttributeError):
            return True
        return old_inputs != new_inputs
    return None


def is_source(path: str) -> bool:
    return path.endswith(".ts") and (path.startswith("src/") or path.startswith("test/"))


def commit_parents(commit: str, run: Run) -> List[str]:
    """The parents of a commit. For the merge commit or the squash that landed a PR, the first is
    the commit of `main` the PR landed on, and the landing commit carries the whole change of the
    PR against it."""
    parents = git_text(["rev-list", "--parents", "-n", "1", commit], run).split()[1:]
    if not parents:
        raise Stop("the commit {} has no parent".format(commit))
    return parents


def uncarried_files(pr: int, changed: List[ChangedFile], run: Run) -> List[str]:
    """The files of the PR that its merge commit with one parent does not change: a rebase merge
    names the last commit of the PR only, and a squash leaves out a change `main` already had."""
    # Not `gh pr view --json files`: it stops at the first 100 files.
    done = run(
        [
            "gh",
            "api",
            "--paginate",
            "repos/{owner}/{repo}/pulls/" + str(pr) + "/files?per_page=100",
            "-q",
            ".[].filename",
        ],
        capture_output=True,
        text=True,
    )
    check(done, "gh api of the files of PR #{} failed".format(pr))
    carried = {path for file in changed for path in (file.old_path, file.new_path)}
    return [path for path in done.stdout.split() if path not in carried]


class Kept(NamedTuple):
    """A `.ts` the PR changed in code, as a path of the commit that holds the text to read: the
    merge commit, or for a deleted spec the first parent of the commit that deleted it."""

    path: str
    commit: str


def uncarried_source(pr: int, path: str, commit: str, main_line: "MainLine", run: Run) -> Kept:
    """A `.ts` of the PR its merge commit does not carry, read at the merge commit; a spec an
    earlier commit of a rebase merge deleted, at the first parent of that commit."""
    if path.startswith("src/") or path in main_line.tree(commit):
        return Kept(path, commit)
    # Along the first parents only: without `--first-parent` `git log` shows no diff for a merge
    # commit, and a spec deleted in the resolution of a merge would not be found.
    deleting = git_text(
        ["log", "-n", "1", "--first-parent", "--diff-filter=D", "--format=%H", commit, "--", path],
        run,
    ).strip()
    if not deleting:
        raise Stop(
            "PR #{}: {} is neither in its merge commit {} nor deleted before it".format(
                pr, path, commit
            )
        )
    return Kept(path, commit_parents(deleting, run)[0])


def changed_code(
    pr: int, commit: str, main_line: "MainLine", run: Run, report: Report
) -> Tuple[List[Kept], List[str]]:
    """The `.ts` of `src/` and `test/` the PR changed in code, and the tools of the run it
    changed."""
    parents = commit_parents(commit, run)
    parent = parents[0]
    kept = []
    tools = []
    changed_list = changed_files(parent, commit, run)
    uncarried = uncarried_files(pr, changed_list, run) if len(parents) == 1 else []
    for path in uncarried:
        report("PR #{}: its merge commit does not carry {}, counted as code".format(pr, path))
        if path in RUN_TOOLS or path in RUN_TOOLS_BY_CONTENT:
            tools.append(path)
        elif is_source(path):
            kept.append(uncarried_source(pr, path, commit, main_line, run))
    for changed in changed_list:
        tool_changed = is_tool_changed(changed, parent, commit, run)
        if tool_changed is not None:
            if tool_changed:
                tools.append(changed.new_path)
            continue
        if not is_source(changed.new_path):
            continue
        if changed.status == "D":
            # A deleted source has nothing left to mutate; a deleted spec leaves the sources it
            # tested with fewer tests.
            if changed.old_path.startswith("test/"):
                kept.append(Kept(changed.old_path, parent))
            continue
        if changed.status == "M":
            old_text = file_at(parent, changed.old_path, run)
            if is_comments_only(old_text, file_at(commit, changed.new_path, run)):
                report("PR #{}: comments only: {}".format(pr, changed.new_path))
                continue
        kept.append(Kept(changed.new_path, commit))
    return kept, tools


class MainLine:
    """The trees of commits and the renames `main` made after a commit, read once each."""

    def __init__(self, head: str, run: Run) -> None:
        self.head = head
        self.run = run
        self.trees: Dict[str, Set[str]] = {}
        self.step_renames: Dict[str, Dict[str, str]] = {}

    def tree(self, commit: str) -> Set[str]:
        if commit not in self.trees:
            listing = git_text(["ls-tree", "-r", "-z", "--name-only", commit], self.run)
            self.trees[commit] = set(listing.split("\0")) - {""}
        return self.trees[commit]

    def path_on_head(self, path: str, commit: str) -> Optional[str]:
        """The name the file of the commit has at the head, None when the head has no such file.
        The renames go commit by commit along the first parents: one end-to-end diff would take a
        file renamed and then rewritten for a deleted one and a new one."""
        steps = git_text(
            [
                "rev-list",
                "--first-parent",
                "--reverse",
                "--parents",
                "{}..{}".format(commit, self.head),
            ],
            self.run,
        ).splitlines()
        for line in steps:
            step, parent = line.split()[:2]
            if step not in self.step_renames:
                self.step_renames[step] = {
                    changed.old_path: changed.new_path
                    for changed in changed_files(parent, step, self.run)
                    if changed.status == "R"
                }
            path = self.step_renames[step].get(path, path)
        return path if path in self.tree(self.head) else None


def imported_sources(test_file: Kept, main_line: MainLine, run: Run) -> List[str]:
    """The files of `src/` a spec or a spec helper imports through `app/*`, its own imports and
    those of the helpers it imports through `test/*`, as paths of its commit."""
    tree = main_line.tree(test_file.commit)
    sources = set()
    seen = set()
    pending = [test_file.path]
    while pending:
        path = pending.pop()
        if path in seen:
            continue
        seen.add(path)
        text = file_at(test_file.commit, path, run)
        try:
            code = "\n".join(Scanner(text).scan().code)
        except Unclear:
            # A commented-out import adds a file to the run, it does not take one away.
            code = text
        for match in IMPORT_FROM_ALIAS.finditer(code):
            base = "src" if match.group("alias") == "app" else "test"
            candidates = [
                "{}/{}.ts".format(base, match.group("module")),
                "{}/{}/index.ts".format(base, match.group("module")),
            ]
            found = next((candidate for candidate in candidates if candidate in tree), None)
            if found is None:
                continue
            if base == "src":
                sources.add(found)
            else:
                pending.append(found)
    return sorted(sources)


def batch_files(batch_issue: int, run: Run, report: Report) -> BatchFiles:
    login = viewer(run)
    batch = find_batch(batch_issue, list_batches(login, run), login)
    fetch(run)
    head = git_text(["rev-parse", "HEAD"], run).strip()
    ordered = sort_records(list_records(batch, login, run), head, run)
    for found in ordered.dropped:
        report("skipped: PR #{}, closed without a merge".format(found.pr))
    for carry in ordered.carried:
        report("left to the carry-over: PR #{}, {}".format(carry.record.pr, carry.why))
    if not ordered.covered:
        raise Stop("no PR of the batch is merged into the head: nothing to run yet")
    main_line = MainLine(head, run)
    files: Set[str] = set()
    reasons = []
    seen_prs = set()
    for found in ordered.covered:
        if found.pr in seen_prs:
            continue
        seen_prs.add(found.pr)
        _, commit = pr_state(found.pr, run)
        kept, tools = changed_code(found.pr, commit, main_line, run, report)
        gone: Set[str] = set()
        reasons.extend(
            "PR #{} changed {}, a tool of the run, in more than comments".format(found.pr, tool)
            for tool in tools
        )
        for kept_file in kept:
            if kept_file.path.startswith("test/"):
                sources = imported_sources(kept_file, main_line, run)
            else:
                sources = [kept_file.path]
            on_head = []
            for source in sources:
                current = main_line.path_on_head(source, kept_file.commit)
                if current is None and source not in gone:
                    gone.add(source)
                    report("PR #{}: no longer on main: {}".format(found.pr, source))
                elif current is not None:
                    on_head.append(current)
            files.update(on_head)
            if kept_file.path.startswith("test/"):
                report(
                    "PR #{}: {} -> {}".format(found.pr, kept_file.path, " ".join(on_head) or "none")
                )
            else:
                report("PR #{}: {}".format(found.pr, " ".join(on_head) or "none"))
    if not files and not reasons:
        reasons.append("no PR of the batch left a file of src/ to mutate on the head")
    return BatchFiles(sorted(files), reasons)


def print_batch_files(batch_issue: int, run: Run = subprocess.run) -> int:
    def report(line: str) -> None:
        print(line, file=sys.stderr)

    try:
        found = batch_files(batch_issue, run, report)
    except Stop as stop:
        print("Stopped: {}".format(stop), file=sys.stderr)
        return 1
    if found.full_run_reasons:
        # An empty stdout is the whole of src/ for make mutation batch=<N>.
        for why in found.full_run_reasons:
            report("full run: {}".format(why))
        return 0
    print(" ".join(found.files))
    return 0

USAGE = (
    "usage: make mutation-full-record issue=<N> pr=<N>\n"
    "       make mutation-full-check pr=<N>\n"
    "       make mutation-batch-files batch=<N>\n"
    '       make mutation-full-close batch=<N> [issues="<N> …"]'
)


def main(argv: Optional[List[str]] = None) -> int:
    # The make targets pass the mode and the numbers in a fixed order, the empty ones as empty
    # strings.
    args = sys.argv[1:] if argv is None else argv
    if not args:
        print(USAGE, file=sys.stderr)
        return 2
    mode, values = args[0], args[1:]
    if mode == "close":
        if len(values) != 2:
            print(USAGE, file=sys.stderr)
            return 2
        # The issues of the survivors come as one argument, separated by blanks.
        values = values[:1] + values[1].split()
    if not all(NUMBER.fullmatch(number) for number in values):
        print(USAGE, file=sys.stderr)
        return 2
    numbers = [int(number) for number in values]
    if mode == "record" and len(numbers) == 2:
        return record(numbers[0], numbers[1])
    if mode == "check" and len(numbers) == 1:
        return check_record(numbers[0])
    if mode == "files" and len(numbers) == 1:
        return print_batch_files(numbers[0])
    if mode == "close":
        return close_batch(numbers[0], numbers[1:])
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
