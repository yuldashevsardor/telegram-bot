"""The green path of a review's mechanical run in one call: the tree, the gates, the cleanup.

The pr-light-check skill hands the action the PR and the gates `/review-pr` turned on
(docs/agents/review-gates.md) and reads one report instead of running every command itself. The
action is called from the tree the review started in, like the other actions of `scripts/review/`:
there the `Makefile` and the actions are the review's own, while in the tree of the PR they are the
code under review. It runs, in this order:

1. `make review-tree-create pr=<N>` gives the tree of the PR head (tree_create.py says how and why).
2. The container gates, each a plain `make` call in the tree of the PR. `rebuild` goes first: the
   throwaway container takes the ready image, and without a rebuild new code is checked against old
   dependencies and an old config, and a green result means nothing. For the same reason a failed
   `rebuild` stops the other container gates, the mutation gates among them: on the old image they
   would give a green that checked nothing, or `Missing script` on a script the PR adds.
3. The `python` gate, `make review-test` in the tree of the PR: the gate checks the PR's specs.
4. The mutation gates. The area comes from `make mutation-area pr=<N> tree=<the tree>`
   (mutation_area.py), the author's record is checked by `make mutation-record`
   (mutation_record.py), both called here. An accepted record gives the `mutation:` line; a record accepted on condition 1
   hands the reviewer the files to apply the table to; a refused record leaves the gate to the
   reviewer's own run of the skill's prose. The new `Stryker disable` marks go to the reviewer to
   read: whether the reason on a mark holds is prose ("Working through survivors" in
   docs/architecture/testing.md), not a rule.
5. `make review-tree-remove` whatever the outcome: a red gate, a stop and an interrupt included.
   SIGTERM and SIGHUP are turned into an interrupt, and run_in_group kills the command it waits for
   together with everything it started; the container of a gate `down --remove-orphans` takes
   down (tree_remove.py). SIGKILL cannot be
   caught: the tree it leaves the next run removes (tree_create.py).

Only the targets named above run. A gate the action does not know gives a `Not run` line and runs
nothing: the list is an allowlist, and a new `Makefile` target counts as dangerous until it is
written in here. Left out on purpose, although they look fitting in a review:

- `lint-fix` and `format` edit the files of the PR: the run would check something other than what
  was sent, and the red of `lint` and `format-check` would disappear together with the finding;
- `test-watch` does not finish but waits for changes, and the run would hang;
- `test` runs the specs of `coverage` without its threshold (docs/architecture/testing.md,
  "Coverage"): a PR that dropped coverage would pass while `make check` fails for the author. So the
  `test` gate runs `make coverage` and loses nothing: `nyc` runs the same `mocha`, a failed spec is
  printed the same way, and the run fails at 100% coverage too; the report goes to `./coverage`,
  which is in `.gitignore`;
- `check` runs four gates in one output, while the verdict needs a line per gate.

`lint` and `format-check` run over the whole repository, without `files=`: `main` is green as a
whole, so anything red was brought by the PR.

The gates of the reviewer's own reading run no command and are passed over. `make-targets`,
`scripts`, the reviewer's own mutation run with its repeats, and the comparison of a red gate with
`origin/main` are the skill's prose for now: each gives a `Not run` line that names it.

The flags are the review's as they came. They change nothing yet: `--no-post` cancels the
publication of the reviewer's own mutation run record, and that run is the skill's.

The report prints the "Checks" lines in the shape of the verdict, then `Not run` and
`Not cleaned up`, then "Red" with an excerpt of every red log, then what is the reviewer's to read.
An excerpt is the tail of the log without the progress of Compose and of the image build, the echo
of make and npm and the coverage table: they fill the end of a log and explain nothing. For the
specs it starts at `N failing`. The whole logs lie in the directory the last line names.
"""

import os
import re
import signal
import subprocess
import sys
import tempfile
from collections import OrderedDict
from typing import Any, Dict, List, MutableMapping, Optional, Tuple

from tree_create import review_tree_path, Stop
from tree_remove import Run, reason

PR_NUMBER = re.compile(r"[1-9][0-9]*")
FLAGS = ("--no-post", "--comment")

# The container gates in the order they run, each with its target.
CONTAINER = [
    ("rebuild", "rebuild"),
    ("build", "build"),
    ("typecheck", "typecheck"),
    ("test", "coverage"),
    ("lint", "lint"),
    ("format-check", "format-check"),
]
READING = ("docs", "docs-sync", "comments", "bug-hunt-high", "bug-hunt-medium", "smells")
BY_SKILL = ("make-targets", "scripts")
KNOWN = [gate for gate, _ in CONTAINER] + ["python", "mutation", "mutation-full"]

BY_SKILL_REASON = "by SKILL.md"
OWN_RUN = "the own run by SKILL.md"

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
MEANINGFUL = re.compile(r"\b(error|fail|failed|failing|fatal|cannot|denied)\b", re.IGNORECASE)
PASSING = re.compile(r"^\s*(\d+) passing\b", re.MULTILINE)
FAILING = re.compile(r"^\s*(\d+) failing\b", re.MULTILINE)
NOISE = [
    # make's echo of a recipe that goes through DC_APP or DC_APP_RUN of the Makefile.
    re.compile(r"^\{ \[ -e \.runtime\.env \]"),
    re.compile(r"^make(\[\d+\])?: \*\*\* "),
    re.compile(r"^\s*(Container|Network|Volume|Image) \S+ \S+\s*$"),
    re.compile(r"^\s*\[\+\] "),
    # npm echoes the script as `> name@version script` and `> command`.
    re.compile(r"^> "),
    re.compile(r"^npm notice"),
    re.compile(
        r"^npm (error|ERR!) (code|path|workspace|location|command|Lifecycle script|A complete log)"
    ),
    re.compile(r"^npm (error|ERR!)\s*$"),
]
# The progress of the image build; a line of it that names a failure stays.
BUILD_STEP = re.compile(r"^#\d+ ")
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")
EXCERPT = 40


class Interrupted(Exception):
    pass


class Report:
    def __init__(self) -> None:
        self.head: Optional[str] = None
        self.checks: "OrderedDict[str, str]" = OrderedDict()
        self.mutation: Optional[str] = None
        self.area: List[str] = []
        self.not_run: "OrderedDict[str, List[str]]" = OrderedDict()
        self.not_cleaned: List[str] = []
        self.red: List[str] = []
        self.marks: List[str] = []
        self.changed: List[str] = []

    def skip(self, check: str, why: str) -> None:
        self.not_run.setdefault(why, []).append(check)

    def print(self, logs: str) -> None:
        if self.head:
            print("Head: {}".format(self.head))
        print("Checks")
        if self.checks:
            print(" · ".join("{}: {}".format(gate, state) for gate, state in self.checks.items()))
        if self.mutation:
            print(self.mutation)
        for why, checks in self.not_run.items():
            print("Not run: {} — {}".format(", ".join(checks), why))
        for line in self.not_cleaned:
            print(line)
        if self.area:
            print("Area: {}".format(" ".join(self.area)))
        if self.red:
            print("Red")
            for line in self.red:
                print(line)
        if self.marks or self.changed:
            print("Yours to read")
        if self.marks:
            print("New Stryker disable marks, each to check against its reason:")
            for line in self.marks:
                print("  " + line)
        if self.changed:
            print(
                "Condition 1 of the record — apply the table of docs/agents/review-gates.md, "
                '"Changes that affect the mutation run", to these files:'
            )
            for line in self.changed:
                print("  " + line)
        print("Logs: {}".format(logs))


def clean(text: str, test: bool) -> List[str]:
    lines = []
    for line in ANSI.sub("", text).splitlines():
        line = line.rstrip()
        if any(noise.search(line) for noise in NOISE):
            continue
        if BUILD_STEP.match(line) and not MEANINGFUL.search(line):
            continue
        # The coverage table of nyc: a row per file, its columns split by `|`.
        if test and line.count("|") >= 3:
            continue
        if not line and (not lines or not lines[-1]):
            continue
        lines.append(line)
    while lines and not lines[-1]:
        lines.pop()
    return lines


def excerpt(text: str, test: bool, log: str) -> Tuple[str, List[str]]:
    """The first meaningful line of a red log and the lines that explain it."""
    lines = clean(text, test)
    start = next((i for i, line in enumerate(lines) if FAILING.match(line)), None)
    if test and start is not None:
        part = lines[start:]
        first = lines[start].strip()
        cut = len(part) > EXCERPT
        part = part[:EXCERPT]
    else:
        part = lines[-EXCERPT:]
        cut = len(lines) > EXCERPT
        first = next((line.strip() for line in part if MEANINGFUL.search(line)), "")
        if not first and part:
            first = part[-1].strip()
    if cut:
        part.append("… cut at {} lines, the whole log: {}".format(EXCERPT, log))
    return first, part


def captured(done: "subprocess.CompletedProcess[str]") -> str:
    return (done.stdout or "") + (done.stderr or "")


class ReviewRun:
    def __init__(self, pr: str, gates: List[str], logs: str, run: Run) -> None:
        self.pr = pr
        self.gates = gates
        self.logs = logs
        self.run = run
        self.here = os.getcwd()
        self.report = Report()
        self.tree: Optional[str] = None
        self.creating = False

    def make(self, args: List[str], cwd: str, log: str) -> "subprocess.CompletedProcess[str]":
        done = self.run(
            ["make"] + args,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
        )
        with open(os.path.join(self.logs, log), "w", encoding="utf-8") as file:
            file.write(done.stdout or "")
        return done

    def on(self, gate: str) -> bool:
        return gate in self.gates

    def create_tree(self) -> Optional[str]:
        """Makes the tree; the reason it was not made otherwise."""
        self.creating = True
        done = self.make(["review-tree-create", "pr=" + self.pr], self.here, "tree-create.log")
        stopped = None
        for line in (done.stdout or "").splitlines():
            if line.startswith("Tree: "):
                self.tree = line[len("Tree: ") :]
            elif line.startswith("Head: "):
                self.report.head = line[len("Head: ") :]
            elif line.startswith("Not cleaned up: "):
                self.report.not_cleaned.append(line)
            elif line.startswith("Stopped: "):
                stopped = line[len("Stopped: ") :]
                # The one stop after the tree was made names it: the tree is removed like any other.
                left = re.search(r"make review-tree-remove path=(\S+)$", line)
                if left:
                    self.tree = left.group(1)
        if done.returncode == 0 and self.tree and self.report.head:
            return None
        return "the tree was not created: {}".format(stopped or reason(done))

    def remove_tree(self) -> None:
        tree = self.tree
        if tree is None:
            return
        done = self.make(["review-tree-remove", "path=" + tree], self.here, "tree-remove.log")
        told = [
            line
            for line in (done.stdout or "").splitlines()
            if line.startswith(("Not cleaned up: ", "Refused: "))
        ]
        self.report.not_cleaned.extend(told)
        if done.returncode != 0 and not told:
            self.report.not_cleaned.append("Not cleaned up: {} — {}".format(tree, reason(done)))

    def container_gates(self) -> None:
        stopped = None
        for gate, target in CONTAINER:
            if not self.on(gate):
                continue
            if stopped:
                self.report.checks[gate] = "n-a"
                self.report.skip(gate, stopped)
                continue
            log = "{}.log".format(target)
            done = self.make([target], self.tree or "", log)
            text = done.stdout or ""
            if gate == "rebuild":
                state = "done" if done.returncode == 0 else "fail"
            else:
                state = "ok" if done.returncode == 0 else "fail"
            if gate == "test":
                plain = ANSI.sub("", text)
                counts = [
                    "{} {}".format(found[-1], word)
                    for found, word in (
                        (PASSING.findall(plain), "passing"),
                        (FAILING.findall(plain), "failing"),
                    )
                    if found
                ]
                if counts:
                    state += " ({})".format(", ".join(counts))
            self.report.checks[gate] = state
            if done.returncode != 0:
                self.red("make " + target, text, gate == "test", log)
                if gate == "rebuild":
                    stopped = "rebuild failed"

    def red(self, command: str, text: str, test: bool, log: str) -> None:
        path = os.path.join(self.logs, log)
        first, lines = excerpt(text, test, path)
        self.report.red.append("- {} — {}".format(command, first or "no output"))
        self.report.red.extend("    " + line if line else "" for line in lines)

    def python_gate(self) -> None:
        done = self.make(["review-test"], self.tree or "", "review-test.log")
        self.report.checks["python"] = "ok" if done.returncode == 0 else "fail"
        if done.returncode != 0:
            self.red("make review-test", done.stdout or "", False, "review-test.log")

    def area(self) -> Optional[List[str]]:
        """The area of the mutation gate, or None when the gate got its line here."""
        done = self.run(
            ["make", "mutation-area", "pr=" + self.pr, "tree=" + (self.tree or "")],
            cwd=self.here,
            capture_output=True,
            text=True,
            errors="replace",
        )
        with open(os.path.join(self.logs, "mutation-area.log"), "w", encoding="utf-8") as file:
            file.write(captured(done))
        notes = [line for line in (done.stderr or "").splitlines() if line.strip()]
        if done.returncode != 0:
            stopped = [line[len("Stopped: ") :] for line in notes if line.startswith("Stopped: ")]
            self.report.mutation = "mutation: n-a — the area was not assembled: {}".format(
                stopped[-1] if stopped else reason(done)
            )
            return None
        area = [line for line in (done.stdout or "").splitlines() if line.strip()]
        if not area:
            self.report.mutation = "mutation: n-a — the area is empty: {}".format(
                "; ".join(notes) or "no reason given"
            )
            return None
        self.report.area = area
        return area

    def record(self, gate: str, area: List[str]) -> None:
        done = self.run(
            [
                "make",
                "mutation-record",
                "pr=" + self.pr,
                "gate=" + gate,
                "area=" + " ".join(area),
                "rebuild=" + ("1" if self.on("rebuild") else ""),
            ],
            cwd=self.here,
            capture_output=True,
            text=True,
            errors="replace",
        )
        with open(os.path.join(self.logs, "mutation-record.log"), "w", encoding="utf-8") as file:
            file.write(captured(done))
        lines = (done.stdout or "").splitlines()
        if done.returncode != 0 or not lines:
            stopped = [
                line[len("Stopped: ") :]
                for line in (done.stderr or "").splitlines()
                if line.startswith("Stopped: ")
            ]
            why = stopped[-1] if stopped else reason(done)
            self.report.skip(
                "mutation", "the record was not checked ({}), {}".format(why, OWN_RUN)
            )
            return
        first = lines[0]
        if first.startswith("refused: "):
            refused = first[len("refused: ") :]
            reasons = [line[2:] for line in lines[1:] if line.startswith("- ")]
            if not refused.startswith("http"):
                reasons = [refused]
            self.report.skip(
                "mutation", "the record was refused ({}), {}".format("; ".join(reasons), OWN_RUN)
            )
            return
        conditional = first.startswith("accepted if the table turns on none of ")
        url = first.rsplit(" ", 1)[-1]
        fields: Dict[str, str] = {}
        survivors: List[str] = []
        listing = False
        for line in lines[1:]:
            if line.startswith("changed between "):
                listing = True
            if listing:
                self.report.changed.append(line.strip())
                if line.startswith("the hunk of a file: "):
                    listing = False
                continue
            key, _, value = line.partition(": ")
            if key in ("head", "exit", "score") and key not in fields:
                fields[key] = value
            elif line.startswith("- "):
                survivors.append(line)
        head = fields.get("head", "")
        score = fields.get("score", "")
        if score == "NaN":
            state = "n-a"
        elif fields.get("exit") == "0":
            state = "ok"
        else:
            state = "fail"
        where = "the whole src/" if gate == "mutation-full" else " ".join(area)
        line = "mutation: {} — {}, {} · accepted record, {}".format(state, score, where, url)
        if "not the PR head" in head:
            earlier = head.split(" ", 1)[0][:7]
            if conditional:
                line += (
                    " (head {} is earlier — if the table turns on none of rebuild, mutation, "
                    'mutation-full for the files under "Yours to read")'.format(earlier)
                )
            else:
                line += (
                    " (head {} is earlier — nothing under the mutation gates came in "
                    "since)".format(earlier)
                )
        if state == "n-a":
            line += ": not a single mutant of the area got into the score"
        self.report.mutation = line
        if state == "fail":
            self.report.red.append(
                "- make mutation (the accepted record) — exit {}, score {}".format(
                    fields.get("exit"), score
                )
            )
            self.report.red.extend("    " + survivor for survivor in survivors)
            self.report.skip("the repeat on the files with survivors", OWN_RUN)

    def marks(self) -> None:
        done = self.run(
            ["gh", "pr", "diff", self.pr], capture_output=True, text=True, errors="replace"
        )
        if done.returncode != 0:
            self.report.skip("the new Stryker disable marks", "gh pr diff failed: " + reason(done))
            return
        self.report.marks = new_marks(done.stdout or "")

    def mutation_gate(self, gate: str, stopped: Optional[str]) -> None:
        area: List[str] = []
        if gate == "mutation":
            # The area is read from the tree of the PR; the record of mutation-full needs no tree.
            if stopped:
                self.report.mutation = "mutation: n-a — {}".format(stopped)
                return
            found = self.area()
            if found is None:
                return
            area = found
        self.record(gate, area)
        self.marks()

    def execute(self) -> None:
        for gate in self.gates:
            if gate in BY_SKILL:
                self.report.skip(gate, BY_SKILL_REASON)
            elif gate not in KNOWN and gate not in READING:
                self.report.skip(gate, "the review run does not know this gate")
        # The table turns mutation on unless mutation-full is: the whole of src/ covers any area.
        mutation = next((g for g in ("mutation-full", "mutation") if self.on(g)), None)
        in_tree = [gate for gate, _ in CONTAINER if self.on(gate)]
        if self.on("python"):
            in_tree.append("python")
        stopped = None
        if in_tree or mutation == "mutation":
            if not self.on("rebuild"):
                self.report.checks["rebuild"] = "not needed"
            stopped = self.create_tree()
        if stopped:
            for gate in in_tree:
                self.report.checks[gate] = "n-a"
                self.report.skip(gate, stopped)
        elif in_tree:
            self.container_gates()
            if self.on("python"):
                self.python_gate()
            if self.report.checks.get("rebuild") == "fail":
                if mutation:
                    self.report.mutation = "mutation: n-a — rebuild failed"
                return
        if mutation:
            self.mutation_gate(mutation, stopped)

    def interrupted(self) -> None:
        """Gives every gate without a line n-a and finds the tree an interrupted creation left."""
        why = "the run was interrupted"
        if not self.on("rebuild") and "rebuild" not in self.report.checks:
            self.report.checks["rebuild"] = "not needed"
        for gate in [g for g, _ in CONTAINER] + ["python"]:
            if self.on(gate) and gate not in self.report.checks:
                self.report.checks[gate] = "n-a"
                self.report.skip(gate, why)
        if (self.on("mutation") or self.on("mutation-full")) and self.report.mutation is None:
            self.report.mutation = "mutation: n-a — {}".format(why)
        # Only a creation this run began can have left a tree it does not know of: whatever lies at
        # the path otherwise is somebody else's, and the next review-tree-create removes a leftover.
        if self.tree is None and self.creating:
            try:
                path = review_tree_path(self.pr, self.run)
            except Stop:
                return
            if os.path.lexists(path):
                self.tree = path


def new_marks(diff: str) -> List[str]:
    """The added lines with a `Stryker disable` mark, as `<file>:<line>: <text>`.

    Only a `.ts` under `src/` is mutated, so a mark anywhere else silences nothing: in the specs it
    is a mistake the reviewer sees in the diff anyway, and in the documentation it is text.
    """
    marks = []
    path: Optional[str] = None
    number = 0
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            path = None
        elif line.startswith("+++ "):
            name = line[len("+++ b/") :] if line.startswith("+++ b/") else ""
            path = name if name.startswith("src/") and name.endswith(".ts") else None
        elif path is None:
            continue
        elif line.startswith("@@"):
            hunk = HUNK.match(line)
            number = int(hunk.group(1)) if hunk else 0
        elif line.startswith("+"):
            if "Stryker disable" in line:
                marks.append("{}:{}: {}".format(path, number, line[1:].strip()))
            number += 1
        elif line.startswith(" "):
            number += 1
    return marks


# The cleanup is not interrupted by a second signal: a tree half removed is worse than one left.
# The flag covers this process from the interrupt to the printed report; the commands it runs are
# kept out of reach of the terminal's Ctrl-C by run_in_group.
CLEANING = {"now": False}


def on_signal(signum: int, frame: object) -> None:
    if not CLEANING["now"]:
        raise Interrupted()


def run_in_group(args: List[str], **kwargs: Any) -> "subprocess.CompletedProcess[str]":
    """subprocess.run in a process group of its own, which an interrupt ends whole.

    subprocess.run kills only its direct child when the wait is interrupted, and a `make` killed
    that way leaves its recipe running: `tree_create.py` would go on to add the tree after the
    cleanup looked for it, and a gate's `docker compose` would keep its container. A group of its
    own also keeps a second Ctrl-C of the terminal away from the cleanup: the signal goes to the
    foreground group, and `make review-tree-remove` is not in it. stdin is closed, so that no
    command waits for input or takes the terminal: the review has nobody to answer.
    """
    if kwargs.pop("capture_output", False):
        kwargs["stdout"] = kwargs["stderr"] = subprocess.PIPE
    with subprocess.Popen(
        args, start_new_session=True, stdin=subprocess.DEVNULL, **kwargs
    ) as process:
        try:
            out, err = process.communicate()
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                # The group ended on its own just before the interrupt.
                pass
            process.wait()
            raise
    return subprocess.CompletedProcess(args, process.returncode, out, err)


def review_run(pr: str, gates: List[str], logs: str, run: Run = run_in_group) -> int:
    review = ReviewRun(pr, gates, logs, run)
    code = 0
    try:
        try:
            review.execute()
        except (KeyboardInterrupt, Interrupted):
            CLEANING["now"] = True
            code = 130
            review.interrupted()
        finally:
            CLEANING["now"] = True
            review.remove_tree()
        review.report.print(logs)
    finally:
        CLEANING["now"] = False
    return code


def forget_make(environ: MutableMapping[str, str]) -> None:
    """Drops what the make of review-run would pass down to every make of the gates.

    make passes its command-line variables to a nested make through MAKEFLAGS and also puts each
    into the environment, where a nested make reads it as a variable of its own: `files=` given to
    review-run by mistake would narrow `make lint` of the PR. MAKELEVEL would make every nested make
    print its directory into the logs.
    """
    names = re.findall(r"(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=", environ.get("MAKEFLAGS", ""))
    for name in names + ["MAKEFLAGS", "MFLAGS", "MAKELEVEL"]:
        environ.pop(name, None)


USAGE = 'usage: make review-run pr=<N> gates="<gates>" [flags="--no-post"]'


def main(argv: Optional[List[str]] = None) -> int:
    # The Makefile passes all three in a fixed order, the empty ones as empty strings.
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 3 or not PR_NUMBER.fullmatch(args[0]) or not args[1].split():
        print(USAGE, file=sys.stderr)
        return 2
    flags = args[2].split()
    if any(flag not in FLAGS for flag in flags):
        print(USAGE, file=sys.stderr)
        return 2
    forget_make(os.environ)
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, on_signal)
    gates = list(OrderedDict.fromkeys(args[1].split()))
    logs = tempfile.mkdtemp(prefix="review-run-{}-".format(args[0]))
    return review_run(args[0], gates, logs)


if __name__ == "__main__":
    sys.exit(main())
