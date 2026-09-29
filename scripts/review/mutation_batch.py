"""Records an issue and its PR in a batch of the deferred full mutation run, or checks the record.

A change to the tools of the mutation run turns on the `mutation-full` gate
(docs/agents/review-gates.md), and a full `make mutation` takes 15+ minutes. Instead of paying that
on every review round, the change is recorded in a batch, and the full run goes once per
`BATCH_SIZE_ISSUES` recorded issues. A batch is an issue titled `Full mutation run <N>`, `<N>` a
plain increment from 1; at most one batch is open at a time. No label marks it:
docs/agents/issue-tracker.md forbids new ones.

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
4. The issue is already recorded in the open batch — changes nothing, so a repeat call or the next
   review round does not count twice.
5. Otherwise adds a comment from templates/mutation-batch-record.md. A record is a comment and not
   an edit of the batch body: an edit is read-modify-write, and of two concurrent edits one is lost
   silently.
6. At `BATCH_SIZE_ISSUES` recorded issues or more prints that the threshold is reached.

`check <pr>` (make mutation-full-check) writes nothing and takes no lock. It takes the issues the PR
closes (`closingIssuesReferences`, the `Closes #N` of its body) and answers whether one of them is
recorded in a batch, open or closed.

A batch or a record counts only when the viewer wrote it, and a record only by its marker, the
first line of its template. The repository is public: anyone can type the title or the marker, and
without the check a stranger's issue would take the place of the batch. The agent and the owner
post from one account, so the viewer is both.

The answer goes to stdout. A failed `gh` or `git` is `Stopped:` on stderr with exit code 1: nothing
was decided, and the caller has to say so. After a stop in the middle of `record` a new batch may
already exist without the record; the repeat call finds it open and records into it.
"""

import fcntl
import json
import os
import re
import subprocess
import sys
from typing import List, NamedTuple, Optional

from tree_remove import Run, reason

BATCH_SIZE_ISSUES = 10
NUMBER = re.compile(r"[1-9][0-9]*")
BATCH_TITLE = re.compile(r"Full mutation run (?P<n>[1-9][0-9]*)")
RECORD_MARKER = re.compile(
    r"<!-- mutation-batch-record issue=(?P<issue>[1-9][0-9]*) pr=(?P<pr>[1-9][0-9]*) -->"
)
# `gh issue create` prints the URL of the issue it made; the URL ends in the issue number.
CREATED_ISSUE = re.compile(r"/issues/(?P<number>[1-9][0-9]*)\s*$")
LOCK_FILE_NAME = "mutation-batch.lock"
TEMPLATES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")


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


def list_records(batch: Batch, login: str, run: Run) -> List[Record]:
    """The records among the batch's comments, in their order."""
    done = run(
        ["gh", "issue", "view", str(batch.issue), "--json", "comments"],
        capture_output=True,
        text=True,
    )
    check(done, "gh issue view {} failed".format(batch.issue))
    records = []
    try:
        for comment in json.loads(done.stdout)["comments"]:
            if (comment["author"] or {}).get("login") != login:
                continue
            first_line = comment["body"].split("\n", 1)[0].strip()
            marker = RECORD_MARKER.fullmatch(first_line)
            if marker is None:
                continue
            issue, pr = int(marker.group("issue")), int(marker.group("pr"))
            records.append(Record(issue, pr, comment["url"]))
    except (ValueError, KeyError, TypeError) as failure:
        raise Stop("gh issue view {} gave no comments — {}".format(batch.issue, failure))
    return records


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


def add_record(batch: Batch, issue: int, pr: int, run: Run) -> str:
    """Comments the record on the batch; the URL of the comment."""
    body = template("mutation-batch-record.md", issue=issue, pr=pr)
    done = run(
        ["gh", "issue", "comment", str(batch.issue), "--body-file", "-"],
        input=body,
        capture_output=True,
        text=True,
    )
    check(done, "gh issue comment {} failed".format(batch.issue))
    return done.stdout.strip()


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
    earlier = [record for record in records if record.issue == issue]
    if earlier:
        print("already recorded: issue #{} — {}".format(issue, earlier[0].url))
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


def record(issue: int, pr: int, run: Run = subprocess.run) -> int:
    try:
        path = lock_path(run)
        # The lock is released when the file is closed, a crash included: the kernel holds it,
        # not the file.
        with open(path, "a", encoding="utf-8") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            record_locked(issue, pr, run)
    except Stop as stop:
        print("Stopped: {}".format(stop), file=sys.stderr)
        return 1
    return 0


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
                if found.issue in issues:
                    print("recorded: issue #{} — {}".format(found.issue, found.url))
                    return 0
    except Stop as stop:
        print("Stopped: {}".format(stop), file=sys.stderr)
        return 1
    named = ", ".join("#{}".format(issue) for issue in issues)
    print("not recorded: no batch records {}, the issues PR #{} closes".format(named, pr))
    return 0


USAGE = (
    "usage: make mutation-full-record issue=<N> pr=<N>\n"
    "       make mutation-full-check pr=<N>"
)


def main(argv: Optional[List[str]] = None) -> int:
    # The make targets pass the mode and the numbers in a fixed order, the empty ones as empty
    # strings.
    args = sys.argv[1:] if argv is None else argv
    if not args or not all(NUMBER.fullmatch(number) for number in args[1:]):
        print(USAGE, file=sys.stderr)
        return 2
    mode, numbers = args[0], [int(number) for number in args[1:]]
    if mode == "record" and len(numbers) == 2:
        return record(numbers[0], numbers[1])
    if mode == "check" and len(numbers) == 1:
        return check_record(numbers[0])
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
