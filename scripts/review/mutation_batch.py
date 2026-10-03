"""Records an issue and its PR in a batch of the deferred full mutation run, checks the record, or
closes the batch after its run.

Any change of code, a `.ts` in `src/` or `test/` or a tool of the mutation run, turns on the
`mutation-full` gate (docs/agents/review-gates.md): a PR runs no mutants of its own. A full
`make mutation` takes hours (item 3 of `close`), and an area run slows down under the load of
parallel sessions.
Instead of paying either on every review round, the change is recorded in a batch, and the full run
goes on fresh `main` once per `BATCH_SIZE_ISSUES` recorded issues. A batch is an issue titled
`Full mutation run <N>`, `<N>` a plain increment from 1; at most one batch is open at a time. No
label marks it: docs/agents/issue-tracker.md forbids new ones.

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

`close <batch> <issues>` (make mutation-full-close) closes a batch after its full run, under the
same lock as `record`:

1. The batch is the viewer's issue `Full mutation run <N>` by its number, open or closed: the PR
   that fixes the survivors closes it through `Closes #<batch>` on its merge. When the batch
   already carries its closing comment, only closing the issue is left, so a repeat call after a
   stop finishes the job, posts nothing twice and reads no run record: by then the record may be
   gone together with the worktree of the run.
2. Reads the record of the full run, reports/mutation/full-record.md (docs/architecture/testing.md,
   "The run record"), and stops unless the run mutated the whole of `src/` on a clean tree and left
   a report with a score.
3. Reads the record of the last run, reports/mutation/record.md. When it is of a run over files, it
   is the check of the fixed survivors: it has to be green, on a clean tree, on a descendant of the
   head of the full run. Which files each round of fixes runs over is step 2 of "A batch as the
   issue" in .claude/commands/solve-issue.md; the record holds the last round, and the earlier
   rounds and their survivors are the caller's check. The full
   run is not repeated for the fixes: in batch 1 (#701) it ran about 190 minutes, not counting 7.5
   hours the machine slept, while the run over the files of its survivors took 43. A run over files
   on the head of the full run checked no fix and stops the close.
4. A red full run (`exit` other than 0) closes only with the issues filed for its survivors named,
   or with the run over files of item 3, or both. A red run over files stops the close even with
   issues named: it is the last round of fixes, and a survivor left to an issue carries a mark
   linking to it, so it does not paint the run red. Whether the issues and the runs cover every
   survivor is the caller's check. A green
   full run has no survivors to fix, and the record of the last run is not read for it.
5. Sorts each recorded PR by `gh pr view`: merged, with its merge commit an ancestor of the head of
   the full run — covered; merged later, or not merged — carried over; closed without a merge —
   dropped.
6. Records the carried ones into the other open batch, created if there is none, from
   templates/mutation-batch-carry.md. An issue already recorded there with the same PR is not
   recorded twice.
7. Comments from templates/mutation-batch-close.md: the head, the three lists, the issues of the
   survivors, the run over files, the record of the full run and the one of the run over files.
   Then closes the issue if it is open.

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

import fcntl
import json
import os
import re
import subprocess
import sys
from typing import Callable, List, NamedTuple, Optional, Tuple

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
    r" exit=(?P<exit>\S+) score=(?P<score>\S+) -->"
)
SHA = re.compile(r"[0-9a-f]{40}")
# `gh issue create` prints the URL of the issue it made; the URL ends in the issue number.
CREATED_ISSUE = re.compile(r"/issues/(?P<number>[1-9][0-9]*)\s*$")
LOCK_FILE_NAME = "mutation-batch.lock"
# Relative to the root of the worktree: the make target runs there, and so did the run. The record
# of the last run, and the one of the last full run, which a run over files leaves alone.
RUN_RECORD_FILE = os.path.join("reports", "mutation", "record.md")
FULL_RUN_RECORD_FILE = os.path.join("reports", "mutation", "full-record.md")
TEMPLATES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")
NOT_MERGED = "not merged"
MERGED_AFTER_HEAD = "merged after the run's head"


class Stop(Exception):
    pass


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
    exit: str
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
        print("threshold reached: the batch is due for its full run")


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
    # A score of NaN is a run without a single valid mutant, a broken `mutate` glob say: it tested
    # nothing, and exits with 0 all the same (docs/architecture/testing.md, "Threshold").
    if marker.group("score") == "NaN":
        raise Stop("the run of {} counted no mutant: score=NaN".format(path))
    return RunRecord(marker.group("head"), marker.group("scope"), marker.group("exit"), text)


def read_full_run(path: str) -> RunRecord:
    text = read_record_file(path)
    if text is None:
        raise Stop("no run record at {}: the full run goes first, make mutation".format(path))
    full_run = parse_run_record(path, text)
    if full_run.scope != "full":
        raise Stop(
            "the run record {} is of a run over files, not of the whole of src/".format(path)
        )
    return full_run


def read_fix_run(path: str, full_run: RunRecord, run: Run) -> Optional[RunRecord]:
    """The run over the files of the survivors after the full run; None when there is no record of
    the last run or that run is the full one."""
    text = read_record_file(path)
    if text is None:
        return None
    fix_run = parse_run_record(path, text)
    if fix_run.scope == "full":
        return None
    if fix_run.exit != "0":
        raise Stop(
            "the run over files of {} is red (exit={}): its survivors are not fixed".format(
                path, fix_run.exit
            )
        )
    if fix_run.head == full_run.head:
        raise Stop(
            "the run over files is on {}, the head of the full run: it checked no fix".format(
                fix_run.head
            )
        )
    if not is_ancestor(full_run.head, fix_run.head, run):
        raise Stop(
            "the run over files on {} does not follow the full run on {}".format(
                fix_run.head, full_run.head
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
    full_run: RunRecord,
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
        fixes = ["the run on `{}`, its record after the one of the full run".format(fix_run.head)]
        fix_record = "\n\n" + fix_run.text.rstrip("\n")
    return template(
        "mutation-batch-close.md",
        head=full_run.head,
        covered=bullets([pair(found) for found in ordered.covered]),
        next_batch=" to #{}".format(next_batch.issue) if next_batch else "",
        carried=bullets(carried),
        dropped=bullets([pair(found) for found in ordered.dropped]),
        issues=bullets(["#{}".format(issue) for issue in survivor_issues]),
        fixes=bullets(fixes),
        run_record=full_run.text.rstrip("\n"),
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


def close_locked(
    batch_issue: int,
    survivor_issues: List[int],
    record_file: str,
    full_record_file: str,
    run: Run,
) -> None:
    login = viewer(run)
    batches = list_batches(login, run)
    closing = next((batch for batch in batches if batch.issue == batch_issue), None)
    if closing is None:
        raise Stop(
            "#{} is no batch: no issue `Full mutation run <N>` of {}".format(batch_issue, login)
        )
    comments = list_comments(closing, login, run)
    closed_before = [comment for comment in comments if CLOSE_MARKER.fullmatch(comment.first_line)]
    if closed_before:
        close_issue(closing, run)
        print("already closed: {}".format(closed_before[0].url))
        return
    full_run = read_full_run(full_record_file)
    fix_run = None
    if full_run.exit != "0":
        fix_run = read_fix_run(record_file, full_run, run)
        if fix_run is None and not survivor_issues:
            raise Stop(
                "the run is red (exit={}): name the issues filed for its survivors, "
                'issues="<N> …", or check the fixed ones with a run over their files'.format(
                    full_run.exit
                )
            )
    fetch(run)
    ordered = sort_records(records_among(comments), full_run.head, run)
    for found in ordered.covered:
        print("covered: issue #{}, PR #{}".format(found.issue, found.pr))
    for found in ordered.dropped:
        print("dropped: issue #{}, PR #{}, closed without a merge".format(found.issue, found.pr))
    next_batch = carry_over(closing, batches, ordered.carried, login, run)
    body = closing_body(full_run, fix_run, ordered, next_batch, survivor_issues)
    url = add_comment(closing, body, run)
    close_issue(closing, run)
    print("closed: {}".format(url))


def close_batch(
    batch_issue: int,
    survivor_issues: List[int],
    run: Run = subprocess.run,
    record_file: str = RUN_RECORD_FILE,
    full_record_file: str = FULL_RUN_RECORD_FILE,
) -> int:
    return locked(
        lambda: close_locked(batch_issue, survivor_issues, record_file, full_record_file, run), run
    )


USAGE = (
    "usage: make mutation-full-record issue=<N> pr=<N>\n"
    "       make mutation-full-check pr=<N>\n"
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
    if mode == "close":
        return close_batch(numbers[0], numbers[1:])
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
