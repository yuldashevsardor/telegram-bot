import fcntl
import io
import json
import os
import re
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock
from urllib.parse import parse_qs, urlparse

import mutation_batch

REPO = "https://github.com/yuldashevsardor/telegram-bot"
HEAD = "a" * 40
SIGNATURE = "_🤖 Posted by Claude Code from the owner's account._"


def batch(number, n, state="open", records=(), creator="owner"):
    """An issue of the fake GitHub titled as batch `n`, with record comments of the viewer."""
    return {
        "number": number,
        "title": "Full mutation run {}".format(n),
        "state": state,
        "creator": creator,
        "comments": [record_comment(issue, pr) for issue, pr in records],
    }


def record_comment(issue, pr, login="owner"):
    return {
        "author": {"login": login},
        "body": mutation_batch.template("mutation-batch-record.md", issue=issue, pr=pr),
    }


def merged(commit):
    return {"state": "MERGED", "mergeCommit": {"oid": commit}}


OPEN = {"state": "OPEN", "mergeCommit": None}
CLOSED = {"state": "CLOSED", "mergeCommit": None}


class FakeGitHub:
    """Stands for subprocess.run: answers gh from the issues and PRs it keeps, and git with the
    common directory and the commits that are ancestors of the run's head. Issues and comments it is
    asked to create are kept too, so a second call sees them.
    """

    def __init__(
        self, issues=(), closes=(), git_dir="", prs=None, ancestors=(), **failures
    ):
        self.issues = {issue["number"]: issue for issue in issues}
        self.closes = list(closes)
        self.git_dir = git_dir
        self.prs = prs or {}
        self.ancestors = set(ancestors)
        self.failures = failures
        self.calls = []
        self.lock_held_on_write = []

    def url(self, number):
        return "{}/issues/{}".format(REPO, number)

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        name = self.name(args)
        if name in self.failures:
            code, error = self.failures[name]
            return subprocess.CompletedProcess(args, code, "", error)
        if name in ("create", "comment", "close"):
            self.lock_held_on_write.append(self.is_locked())
        if name == "merge-base":
            code = 0 if args[3] in self.ancestors else 1
            return subprocess.CompletedProcess(args, code, "", "")
        return subprocess.CompletedProcess(args, 0, self.answer(name, args, kwargs), "")

    def name(self, args):
        if args[0] == "git":
            return args[1]
        if args[1] == "api":
            return "user" if args[2] == "user" else "list"
        return args[2]

    def answer(self, name, args, kwargs):
        if name == "rev-parse":
            return self.git_dir + "\n"
        if name == "fetch":
            return ""
        if name == "user":
            return "owner\n"
        if name == "list":
            creator = parse_qs(urlparse(args[3]).query)["creator"][0]
            lines = [
                json.dumps(
                    {
                        "number": issue["number"],
                        "state": issue["state"],
                        "title": issue["title"],
                        "html_url": self.url(issue["number"]),
                    }
                )
                for issue in sorted(self.issues.values(), key=lambda i: -i["number"])
                if issue["creator"] == creator
            ]
            return "\n".join(lines) + "\n"
        if name == "view" and args[1] == "issue":
            number = int(args[3])
            comments = [
                dict(comment, url="{}#issuecomment-{}".format(self.url(number), index))
                for index, comment in enumerate(self.issues[number]["comments"], 1)
            ]
            return json.dumps({"comments": comments})
        if name == "view" and args[5] == "state,mergeCommit":
            return json.dumps(self.prs[int(args[3])])
        if name == "view":
            return json.dumps(
                {"closingIssuesReferences": [{"number": number} for number in self.closes]}
            )
        if name == "create":
            number = max(self.issues, default=600) + 1
            title = args[args.index("--title") + 1]
            self.issues[number] = {
                "number": number,
                "title": title,
                "state": "open",
                "creator": "owner",
                "body": kwargs["input"],
                "comments": [],
            }
            return self.url(number) + "\n"
        if name == "close":
            self.issues[int(args[3])]["state"] = "closed"
            return ""
        # comment
        number = int(args[3])
        comments = self.issues[number]["comments"]
        comments.append({"author": {"login": "owner"}, "body": kwargs["input"]})
        return "{}#issuecomment-{}\n".format(self.url(number), len(comments))

    def is_locked(self):
        """Whether somebody holds the lock: a second open file cannot take it."""
        path = os.path.join(self.git_dir, mutation_batch.LOCK_FILE_NAME)
        with open(path, "a", encoding="utf-8") as other:
            try:
                fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            fcntl.flock(other, fcntl.LOCK_UN)
            return False

    def called(self, name):
        return [args for args in self.calls if self.name(args) == name]


def answer(call, *args):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = call(*args)
    return code, out.getvalue().splitlines(), err.getvalue()


class RecordTest(unittest.TestCase):
    def setUp(self):
        self.git_dir = tempfile.mkdtemp(prefix="mutation-batch-")

    def github(self, *issues, **failures):
        return FakeGitHub(issues, git_dir=self.git_dir, **failures)

    def record(self, github, issue=655, pr=660):
        return answer(mutation_batch.record, issue, pr, github)

    def test_creates_the_first_batch_when_there_is_none(self):
        github = self.github()

        code, lines, _ = self.record(github)

        self.assertEqual(code, 0)
        self.assertEqual(github.issues[601]["title"], "Full mutation run 1")
        self.assertEqual(
            lines,
            [
                "created: {}/issues/601".format(REPO),
                "recorded: issue #655, PR #660 — {}/issues/601#issuecomment-1".format(REPO),
                "issues in the batch: 1 of 20 — {}/issues/601".format(REPO),
            ],
        )

    def test_the_new_batch_body_names_the_threshold_and_carries_the_signature(self):
        github = self.github()

        self.record(github)

        body = github.issues[601]["body"]
        self.assertIn("At 20 recorded issues the batch is due", body)
        self.assertTrue(
            body.endswith("_🤖 Posted by Claude Code from the owner's account._\n"), body
        )

    def test_the_new_batch_takes_the_number_after_the_greatest_one(self):
        github = self.github(
            batch(610, 2, "closed"), batch(605, 3, "closed"), batch(620, 1, "closed")
        )

        self.record(github)

        self.assertEqual(github.issues[621]["title"], "Full mutation run 4")

    def test_records_into_the_open_batch_without_creating_one(self):
        github = self.github(batch(610, 1, "closed"), batch(630, 2, records=[(640, 641)]))

        code, lines, _ = self.record(github)

        self.assertEqual(code, 0)
        self.assertEqual(github.called("create"), [])
        self.assertEqual(
            [comment["body"].splitlines()[0] for comment in github.issues[630]["comments"]],
            [
                "<!-- mutation-batch-record issue=640 pr=641 -->",
                "<!-- mutation-batch-record issue=655 pr=660 -->",
            ],
        )
        self.assertEqual(lines[-1], "issues in the batch: 2 of 20 — {}/issues/630".format(REPO))

    def test_the_record_comment_names_the_issue_and_the_pr_and_carries_the_signature(self):
        github = self.github(batch(630, 1))

        self.record(github)

        self.assertEqual(
            github.issues[630]["comments"][0]["body"],
            "<!-- mutation-batch-record issue=655 pr=660 -->\n"
            "Recorded: issue #655, PR #660.\n"
            "\n"
            "_🤖 Posted by Claude Code from the owner's account._\n",
        )

    def test_an_issue_already_recorded_with_the_pr_is_not_recorded_twice(self):
        github = self.github(batch(630, 1, records=[(655, 660), (640, 641)]))

        code, lines, _ = self.record(github, 655, 660)

        self.assertEqual(code, 0)
        self.assertEqual(github.called("comment"), [])
        self.assertEqual(
            lines,
            [
                "already recorded: issue #655, PR #660 — {}/issues/630#issuecomment-1".format(
                    REPO
                ),
                "issues in the batch: 2 of 20 — {}/issues/630".format(REPO),
            ],
        )

    def test_a_pr_that_replaces_another_is_recorded_and_the_issue_counted_once(self):
        github = self.github(batch(630, 1, records=[(655, 656), (640, 641)]))

        code, lines, _ = self.record(github, 655, 660)

        self.assertEqual(code, 0)
        self.assertEqual(
            lines,
            [
                "recorded: issue #655, PR #660 — {}/issues/630#issuecomment-3".format(REPO),
                "issues in the batch: 2 of 20 — {}/issues/630".format(REPO),
            ],
        )

    def test_a_repeated_call_leaves_one_record(self):
        github = self.github()

        self.record(github)
        self.record(github)

        self.assertEqual(len(github.issues), 1)
        self.assertEqual(len(github.issues[601]["comments"]), 1)

    def test_the_twentieth_issue_reaches_the_threshold(self):
        nineteen = [(issue, issue + 100) for issue in range(1, 20)]
        github = self.github(batch(630, 1, records=nineteen))

        _, lines, _ = self.record(github)

        self.assertEqual(
            lines[-2:],
            [
                "issues in the batch: 20 of 20 — {}/issues/630".format(REPO),
                "threshold reached: the batch is due for its run",
            ],
        )

    def test_the_nineteenth_issue_does_not_reach_the_threshold(self):
        eighteen = [(issue, issue + 100) for issue in range(1, 19)]
        github = self.github(batch(630, 1, records=eighteen))

        _, lines, _ = self.record(github)

        self.assertEqual(lines[-1], "issues in the batch: 19 of 20 — {}/issues/630".format(REPO))

    def test_a_batch_past_the_threshold_still_takes_records(self):
        twenty = [(issue, issue + 100) for issue in range(1, 21)]
        github = self.github(batch(630, 1, records=twenty))

        _, lines, _ = self.record(github)

        self.assertEqual(len(github.called("comment")), 1)
        self.assertEqual(lines[-1], "threshold reached: the batch is due for its run")

    def test_the_lock_is_held_while_the_batch_is_created_and_recorded_into(self):
        github = self.github()

        self.record(github)

        self.assertEqual(github.lock_held_on_write, [True, True])
        self.assertFalse(github.is_locked())

    def test_the_lock_lies_in_the_common_git_directory(self):
        github = self.github()

        self.record(github)

        self.assertEqual(
            github.called("rev-parse"),
            [["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]],
        )
        self.assertTrue(os.path.exists(os.path.join(self.git_dir, "mutation-batch.lock")))

    def test_lists_only_the_issues_the_viewer_created(self):
        github = self.github(batch(630, 1, creator="stranger"))

        self.record(github)

        self.assertIn("creator=owner", github.called("list")[0][3])
        self.assertEqual(github.issues[631]["title"], "Full mutation run 1")
        self.assertEqual(github.issues[630]["comments"], [])

    def test_a_title_that_only_contains_the_batch_title_is_not_a_batch(self):
        github = self.github(
            dict(batch(630, 1), title="Full mutation run 1 is slow"),
            dict(batch(631, 2), title="Re: Full mutation run 2"),
            dict(batch(632, 3), title="Full mutation run 03"),
        )

        self.record(github)

        self.assertEqual(github.issues[633]["title"], "Full mutation run 1")

    def test_a_record_of_another_account_or_a_quoted_marker_does_not_count(self):
        github = self.github(batch(630, 1))
        marker = "<!-- mutation-batch-record issue=655 pr=656 -->"
        github.issues[630]["comments"] = [
            {"author": {"login": "stranger"}, "body": marker},
            {"author": {"login": "owner"}, "body": "As the record says:\n" + marker},
            {"author": None, "body": marker},
        ]

        _, lines, _ = self.record(github)

        self.assertEqual(
            lines[0], "recorded: issue #655, PR #660 — {}/issues/630#issuecomment-4".format(REPO)
        )
        self.assertEqual(lines[-1], "issues in the batch: 1 of 20 — {}/issues/630".format(REPO))

    def test_two_open_batches_stop_without_a_write(self):
        github = self.github(batch(630, 1), batch(631, 2))

        code, lines, err = self.record(github)

        self.assertEqual((code, lines), (1, []))
        self.assertIn("Stopped: more than one batch is open:", err)
        self.assertEqual(github.called("comment") + github.called("create"), [])

    def test_a_failed_gh_stops(self):
        for name, error, told in (
            ("user", "HTTP 401: Bad credentials", "gh api user failed"),
            ("list", "HTTP 502: Bad Gateway", "gh api of the issues failed"),
            ("create", "HTTP 403: Forbidden", "gh issue create failed"),
        ):
            code, lines, err = self.record(self.github(**{name: (1, error)}))

            self.assertEqual(code, 1, name)
            self.assertNotIn("recorded", " ".join(lines), name)
            self.assertIn("Stopped: {} — {}".format(told, error), err)

    def test_a_failed_comment_stops(self):
        code, _, err = self.record(self.github(batch(630, 1), comment=(1, "HTTP 502")))

        self.assertEqual(code, 1)
        self.assertIn("Stopped: gh issue comment 630 failed — HTTP 502", err)

    def test_a_git_that_did_not_run_stops_before_gh(self):
        github = self.github(**{"rev-parse": (128, "fatal: not a git repository")})

        code, _, err = self.record(github)

        self.assertEqual(code, 1)
        self.assertIn("Stopped: git rev-parse --git-common-dir failed", err)
        self.assertEqual([args[0] for args in github.calls], ["git"])

    def test_an_answer_that_is_not_json_stops(self):
        class NotJson(FakeGitHub):
            def answer(self, name, args, kwargs):
                if name == "view":
                    return "<html>"
                return super().answer(name, args, kwargs)

        github = NotJson([batch(630, 1)], git_dir=self.git_dir)

        code, _, err = self.record(github)

        self.assertEqual(code, 1)
        self.assertIn("Stopped: gh issue view 630 gave no comments", err)


class CheckTest(unittest.TestCase):
    def check(self, github, pr=660):
        return answer(mutation_batch.check_record, pr, github)

    def test_an_issue_recorded_in_a_closed_batch_is_recorded(self):
        github = FakeGitHub(
            [batch(630, 1, "closed", records=[(640, 641), (655, 660)]), batch(650, 2)],
            closes=[655],
        )

        code, lines, _ = self.check(github)

        self.assertEqual(code, 0)
        self.assertEqual(
            lines, ["recorded: issue #655 — {}/issues/630#issuecomment-2".format(REPO)]
        )

    def test_an_issue_recorded_in_no_batch_is_not_recorded(self):
        github = FakeGitHub([batch(630, 1, records=[(640, 641)])], closes=[655, 657])

        code, lines, _ = self.check(github)

        self.assertEqual(code, 0)
        self.assertEqual(
            lines, ["not recorded: no batch records PR #660 with #655, #657, the issues it closes"]
        )

    def test_a_record_of_the_issue_with_another_pr_does_not_count(self):
        github = FakeGitHub([batch(630, 1, records=[(655, 656)])], closes=[655])

        code, lines, _ = self.check(github)

        self.assertEqual(code, 0)
        self.assertEqual(
            lines, ["not recorded: no batch records PR #660 with #655, the issues it closes"]
        )

    def test_one_of_the_closed_issues_recorded_is_enough(self):
        github = FakeGitHub([batch(630, 1, records=[(657, 660)])], closes=[655, 657])

        _, lines, _ = self.check(github)

        self.assertEqual(
            lines, ["recorded: issue #657 — {}/issues/630#issuecomment-1".format(REPO)]
        )

    def test_a_pr_that_closes_no_issue_is_not_recorded(self):
        github = FakeGitHub([batch(630, 1, records=[(655, 660)])])

        code, lines, _ = self.check(github)

        self.assertEqual(code, 0)
        self.assertEqual(lines, ["not recorded: PR #660 closes no issue"])

    def test_a_record_of_another_account_does_not_count(self):
        github = FakeGitHub([batch(630, 1)], closes=[655])
        github.issues[630]["comments"] = [record_comment(655, 660, login="stranger")]

        _, lines, _ = self.check(github)

        self.assertEqual(lines[0][: len("not recorded")], "not recorded")

    def test_the_check_writes_nothing_and_takes_no_lock(self):
        github = FakeGitHub([batch(630, 1)], closes=[655])

        self.check(github)

        self.assertEqual({github.name(args) for args in github.calls}, {"view", "user", "list"})

    def test_a_failed_gh_stops(self):
        code, lines, err = self.check(FakeGitHub(closes=[655], view=(1, "HTTP 404: Not Found")))

        self.assertEqual((code, lines), (1, []))
        self.assertIn("Stopped: gh pr view 660 failed — HTTP 404: Not Found", err)


def run_record(
    head=HEAD, clean="yes", scope="files", batch="630", exit_code=0, score="100.00"
):
    marker = "<!-- mutation-run head={} clean={} scope={} batch={} exit={} score={} -->".format(
        head, clean, scope, batch, exit_code, score
    )
    return marker + "\n## `make mutation` run record\n\n- head: `{}`\n".format(head)


FIX_HEAD = "b" * 40


class CloseTest(unittest.TestCase):
    def setUp(self):
        self.git_dir = tempfile.mkdtemp(prefix="mutation-batch-")
        self.record_file = os.path.join(self.git_dir, "record.md")
        self.batch_record_file = os.path.join(self.git_dir, "batch-record.md")
        self.write_batch_run(run_record())

    def write_batch_run(self, text):
        """As the wrapper does after a batch run: the record goes into both files."""
        self.write_run_record(text)
        with open(self.batch_record_file, "w", encoding="utf-8") as file:
            file.write(text)

    def write_run_record(self, text):
        with open(self.record_file, "w", encoding="utf-8") as file:
            file.write(text)

    def red_run_fixed(self, fix_record):
        """A red batch run, then a run over the files of its survivors on FIX_HEAD."""
        self.write_batch_run(run_record(exit_code=1, score="99.50"))
        self.write_run_record(fix_record)

    def github(self, *issues, prs=None, ancestors=(), **failures):
        return FakeGitHub(
            issues, git_dir=self.git_dir, prs=prs, ancestors=ancestors, **failures
        )

    def close(self, github, batch_issue=630, survivor_issues=()):
        return answer(
            mutation_batch.close_batch,
            batch_issue,
            list(survivor_issues),
            github,
            self.record_file,
            self.batch_record_file,
        )

    def four_prs(self, *others):
        """Batch 630 with a PR of each fate: covered, merged after the head, open, closed."""
        return self.github(
            batch(630, 1, records=[(701, 801), (702, 802), (703, 803), (704, 804)]),
            *others,
            prs={801: merged("c1"), 802: merged("c2"), 803: OPEN, 804: CLOSED},
            ancestors=["c1"],
        )

    def test_sorts_the_prs_and_carries_the_uncovered_ones_into_a_new_batch(self):
        github = self.four_prs()

        code, lines, err = self.close(github)

        self.assertEqual((code, err), (0, ""))
        self.assertEqual(github.issues[631]["title"], "Full mutation run 2")
        self.assertEqual(
            [comment["body"].splitlines()[0] for comment in github.issues[631]["comments"]],
            [
                "<!-- mutation-batch-record issue=702 pr=802 -->",
                "<!-- mutation-batch-record issue=703 pr=803 -->",
            ],
        )
        self.assertEqual(
            lines,
            [
                "covered: issue #701, PR #801",
                "dropped: issue #704, PR #804, closed without a merge",
                "created: {}/issues/631".format(REPO),
                "carried: issue #702, PR #802, merged after the run's head — "
                "{}/issues/631#issuecomment-1".format(REPO),
                "carried: issue #703, PR #803, not merged — "
                "{}/issues/631#issuecomment-2".format(REPO),
                "closed: {}/issues/630#issuecomment-5".format(REPO),
            ],
        )
        self.assertEqual(github.issues[630]["state"], "closed")

    def test_the_carried_record_counts_as_a_record_of_the_next_batch(self):
        github = self.four_prs()

        self.close(github)

        self.assertEqual(
            github.issues[631]["comments"][1]["body"],
            "<!-- mutation-batch-record issue=703 pr=803 -->\n"
            "Recorded: issue #703, PR #803, carried over from #630: not merged.\n"
            "\n" + SIGNATURE + "\n",
        )
        # The listing goes newest first, so the check meets the carried record before the first.
        checked = FakeGitHub(github.issues.values(), closes=[703])
        _, lines, _ = answer(mutation_batch.check_record, 803, checked)
        self.assertEqual(
            lines, ["recorded: issue #703 — {}/issues/631#issuecomment-2".format(REPO)]
        )

    def test_the_closing_comment_lists_the_fates_the_issues_and_the_run_record(self):
        github = self.four_prs()
        self.write_batch_run(run_record(exit_code=1, score="99.50"))

        self.close(github, survivor_issues=[901, 902])

        self.assertEqual(
            github.issues[630]["comments"][-1]["body"],
            "<!-- mutation-batch-close head={head} -->\n"
            "Closed after the batch run on `{head}`.\n"
            "\n"
            "Covered, merged into the head of the run:\n"
            "- issue #701, PR #801\n"
            "\n"
            "Carried over to #631:\n"
            "- issue #702, PR #802, merged after the run's head\n"
            "- issue #703, PR #803, not merged\n"
            "\n"
            "Dropped, closed without a merge:\n"
            "- issue #704, PR #804\n"
            "\n"
            "Issues filed for the survivors of the run:\n"
            "- #901\n"
            "- #902\n"
            "\n"
            "Survivors fixed, checked by a run over their files:\n"
            "- none\n"
            "\n"
            "{record}"
            "\n"
            "{signature}\n".format(
                head=HEAD, record=run_record(exit_code=1, score="99.50"), signature=SIGNATURE
            ),
        )

    def test_carries_into_the_open_batch_and_skips_a_pr_already_there(self):
        github = self.four_prs(batch(640, 2, records=[(702, 802), (703, 903)]))

        _, lines, _ = self.close(github)

        self.assertEqual(github.called("create"), [])
        self.assertEqual(
            [comment["body"].splitlines()[0] for comment in github.issues[640]["comments"]],
            [
                "<!-- mutation-batch-record issue=702 pr=802 -->",
                "<!-- mutation-batch-record issue=703 pr=903 -->",
                "<!-- mutation-batch-record issue=703 pr=803 -->",
            ],
        )
        self.assertIn(
            "already carried: issue #702, PR #802 — {}/issues/640#issuecomment-1".format(REPO),
            lines,
        )

    def test_nothing_to_carry_creates_no_batch(self):
        github = self.github(
            batch(630, 1, records=[(701, 801), (704, 804)]),
            prs={801: merged("c1"), 804: CLOSED},
            ancestors=["c1"],
        )

        code, _, _ = self.close(github)

        self.assertEqual(code, 0)
        self.assertEqual(github.called("create"), [])
        self.assertIn(
            "Carried over:\n- none\n", github.issues[630]["comments"][-1]["body"]
        )

    def test_each_pr_of_an_issue_is_sorted_on_its_own(self):
        github = self.github(
            batch(630, 1, records=[(701, 801), (701, 802)]),
            prs={801: CLOSED, 802: merged("c2")},
        )

        _, lines, _ = self.close(github)

        self.assertEqual(lines[0], "dropped: issue #701, PR #801, closed without a merge")
        self.assertEqual(
            github.issues[631]["comments"][0]["body"].splitlines()[0],
            "<!-- mutation-batch-record issue=701 pr=802 -->",
        )

    def test_a_batch_closed_by_the_merge_of_its_fix_gets_the_comment_and_no_second_close(self):
        github = self.four_prs()
        github.issues[630]["state"] = "closed"

        code, _, _ = self.close(github)

        self.assertEqual(code, 0)
        self.assertEqual(github.called("close"), [])
        first_line = github.issues[630]["comments"][-1]["body"].splitlines()[0]
        self.assertEqual(first_line, "<!-- mutation-batch-close head={} -->".format(HEAD))

    def test_a_repeated_close_posts_nothing_twice(self):
        github = self.four_prs()

        self.close(github)
        comments = sum(len(issue["comments"]) for issue in github.issues.values())
        code, lines, _ = self.close(github)

        self.assertEqual(code, 0)
        self.assertEqual(lines, ["already closed: {}/issues/630#issuecomment-5".format(REPO)])
        self.assertEqual(
            sum(len(issue["comments"]) for issue in github.issues.values()), comments
        )
        self.assertEqual(len(github.called("close")), 1)

    def test_a_close_stopped_after_its_comment_closes_the_issue_on_the_repeat(self):
        github = self.four_prs()
        self.close(github)
        github.issues[630]["state"] = "open"

        code, _, _ = self.close(github)

        self.assertEqual(code, 0)
        self.assertEqual(github.issues[630]["state"], "closed")

    def test_a_repeat_after_the_closing_comment_needs_no_run_record(self):
        github = self.four_prs()
        github.failures["close"] = (1, "HTTP 502")
        self.close(github)
        del github.failures["close"]
        os.remove(self.record_file)
        os.remove(self.batch_record_file)

        code, lines, err = self.close(github)

        self.assertEqual((code, err), (0, ""))
        self.assertEqual(lines, ["already closed: {}/issues/630#issuecomment-5".format(REPO)])
        self.assertEqual(github.issues[630]["state"], "closed")

    def test_a_close_stopped_after_the_next_batch_was_created_takes_it_on_the_repeat(self):
        github = self.four_prs()
        github.failures["close"] = (1, "HTTP 502")
        self.close(github)
        del github.failures["close"]

        code, _, _ = self.close(github)

        self.assertEqual(code, 0)
        self.assertEqual(sorted(github.issues), [630, 631])
        self.assertEqual(len(github.issues[631]["comments"]), 2)

    def test_the_lock_is_held_on_every_write(self):
        github = self.four_prs()

        self.close(github)

        self.assertEqual(github.lock_held_on_write, [True] * 5)
        self.assertFalse(github.is_locked())

    def test_the_merge_commits_are_fetched_before_they_are_compared(self):
        github = self.four_prs()

        self.close(github)

        names = [github.name(args) for args in github.calls]
        self.assertLess(names.index("fetch"), names.index("merge-base"))
        self.assertEqual(
            github.called("merge-base")[0], ["git", "merge-base", "--is-ancestor", "c1", HEAD]
        )

    def test_a_run_record_that_ties_the_run_to_no_clean_commit_of_the_batch_stops_before_a_write(
        self,
    ):
        for text, told in (
            (run_record(batch="none"), "is of batch=none, not of #630"),
            (run_record(batch="640"), "is of batch=640, not of #630"),
            (run_record(clean="no"), "ties the run to no commit: clean=no"),
            (run_record(head="unknown", clean="unknown"), "clean=unknown, head=unknown"),
            (run_record(score="none", exit_code=1), "broke off before its report"),
            (run_record(scope="full", score="NaN"), "counted no mutant: score=NaN"),
            (run_record(exit_code=1, score="99.50"), "the run is red (exit=1)"),
            ("## `make mutation` run record\n", "does not open with the marker of a run record"),
        ):
            self.write_batch_run(text)
            github = self.four_prs()

            code, lines, err = self.close(github)

            self.assertEqual((code, lines), (1, []), told)
            self.assertIn(told, err)
            self.assertEqual(github.lock_held_on_write, [], told)
            self.assertEqual(github.called("fetch"), [], told)

    def test_a_batch_run_over_files_without_a_mutant_closes(self):
        self.write_batch_run(run_record(score="NaN"))
        github = self.four_prs()

        code, _, err = self.close(github)

        self.assertEqual((code, err), (0, ""))
        self.assertEqual(github.issues[630]["state"], "closed")

    def test_a_run_over_files_without_a_mutant_checks_no_fix(self):
        github = self.four_prs()
        github.ancestors.add(HEAD)
        self.red_run_fixed(run_record(head=FIX_HEAD, batch="none", score="NaN"))

        code, _, err = self.close(github)

        self.assertEqual(code, 1)
        self.assertIn("counted no mutant: score=NaN", err)

    def test_no_batch_run_record_stops(self):
        os.remove(self.batch_record_file)

        code, _, err = self.close(self.four_prs())

        self.assertEqual(code, 1)
        self.assertIn(
            "Stopped: no run record at {}: the batch run goes first, "
            "make mutation batch=630".format(self.batch_record_file),
            err,
        )

    def test_a_green_batch_run_closes_without_reading_the_record_of_the_last_run(self):
        for fix_record in (None, run_record(head=FIX_HEAD, batch="none", exit_code=1)):
            if fix_record is None:
                os.remove(self.record_file)
            else:
                self.write_run_record(fix_record)
            github = self.four_prs()

            code, _, err = self.close(github)

            self.assertEqual((code, err), (0, ""))
            self.assertIn(
                "Survivors fixed, checked by a run over their files:\n- none\n",
                github.issues[630]["comments"][-1]["body"],
            )

    def test_a_red_batch_run_closes_on_a_green_run_over_files_that_follows_it(self):
        github = self.four_prs()
        github.ancestors.add(HEAD)
        fix_record = run_record(head=FIX_HEAD, batch="none")
        self.red_run_fixed(fix_record)

        code, _, err = self.close(github)

        self.assertEqual((code, err), (0, ""))
        self.assertIn(["git", "merge-base", "--is-ancestor", HEAD, FIX_HEAD], github.calls)
        body = github.issues[630]["comments"][-1]["body"]
        self.assertTrue(body.startswith("<!-- mutation-batch-close head={} -->\n".format(HEAD)))
        self.assertIn(
            "Issues filed for the survivors of the run:\n"
            "- none\n"
            "\n"
            "Survivors fixed, checked by a run over their files:\n"
            "- the run on `{fix}`, its record after the one of the batch run\n"
            "\n"
            "{full}"
            "\n"
            "{fix_record}"
            "\n"
            "{signature}\n".format(
                fix=FIX_HEAD,
                full=run_record(exit_code=1, score="99.50"),
                fix_record=fix_record,
                signature=SIGNATURE,
            ),
            body,
        )

    def test_a_run_over_files_that_checks_no_fix_stops_before_a_write(self):
        for fix_record, ancestors, told in (
            (
                run_record(head=FIX_HEAD, batch="none", exit_code=1, score="99.00"),
                [HEAD],
                "is red (exit=1): its survivors are not fixed",
            ),
            (
                run_record(head=FIX_HEAD, batch="none"),
                [],
                "the run over files on {} does not follow the batch run on {}".format(
                    FIX_HEAD, HEAD
                ),
            ),
            (
                run_record(head=FIX_HEAD, batch="none", clean="no"),
                [HEAD],
                "ties the run to no commit: clean=no",
            ),
            (
                run_record(head=HEAD, batch="none"),
                [HEAD],
                "the run over files is on {}, the head of the batch run: it checked no fix".format(
                    HEAD
                ),
            ),
        ):
            for survivor_issues in ((), (901,)):
                github = self.four_prs()
                github.ancestors.update(ancestors)
                self.red_run_fixed(fix_record)

                code, lines, err = self.close(github, survivor_issues=survivor_issues)

                self.assertEqual((code, lines), (1, []), told)
                self.assertIn(told, err)
                self.assertEqual(github.lock_held_on_write, [], told)
                self.assertEqual(github.called("fetch"), [], told)

    def test_a_red_batch_run_closes_on_issues_and_a_run_over_files_together(self):
        github = self.four_prs()
        github.ancestors.add(HEAD)
        self.red_run_fixed(run_record(head=FIX_HEAD, batch="none"))

        code, _, err = self.close(github, survivor_issues=[901])

        self.assertEqual((code, err), (0, ""))
        self.assertIn(
            "Issues filed for the survivors of the run:\n"
            "- #901\n"
            "\n"
            "Survivors fixed, checked by a run over their files:\n"
            "- the run on `{}`, its record after the one of the batch run\n".format(FIX_HEAD),
            github.issues[630]["comments"][-1]["body"],
        )

    def test_a_number_that_is_no_batch_of_the_viewer_stops(self):
        for github in (self.four_prs(), self.github(batch(630, 1, creator="stranger"))):
            code, _, err = self.close(github, batch_issue=650 if github.prs else 630)

            self.assertEqual(code, 1)
            self.assertIn("is no batch: no issue `Full mutation run <N>` of owner", err)

    def test_two_other_open_batches_stop_without_a_write(self):
        github = self.four_prs(batch(640, 2), batch(641, 3))

        code, _, err = self.close(github)

        self.assertEqual(code, 1)
        self.assertIn("Stopped: more than one other batch is open:", err)
        self.assertEqual(github.called("comment") + github.called("create"), [])

    def test_a_failed_git_or_gh_stops(self):
        for name, error, told in (
            ("fetch", "fatal: unable to access", "git fetch origin failed"),
            ("merge-base", "fatal: Not a valid commit name c1", "git merge-base --is-ancestor c1"),
            ("view", "HTTP 502", "gh issue view 630 failed"),
        ):
            github = self.four_prs()
            github.failures[name] = (128 if name != "view" else 1, error)

            code, _, err = self.close(github)

            self.assertEqual(code, 1, name)
            self.assertIn(told, err)
            self.assertEqual(github.called("comment"), [], name)

    def test_a_merged_pr_without_a_merge_commit_stops(self):
        github = self.four_prs()
        github.prs[801] = {"state": "MERGED", "mergeCommit": None}

        code, _, err = self.close(github)

        self.assertEqual(code, 1)
        self.assertIn("gh pr view 801 named no merge commit of a merged PR", err)


class CommentsOnlyTest(unittest.TestCase):
    def assertCommentsOnly(self, old, new):
        self.assertTrue(mutation_batch.is_comments_only(old, new), (old, new))

    def assertCode(self, old, new):
        self.assertFalse(mutation_batch.is_comments_only(old, new), (old, new))

    def test_a_change_of_comments_alone_is_comments_only(self):
        self.assertCommentsOnly("// old\nconst a = 1;\n", "// new\nconst a = 1;\n")
        self.assertCommentsOnly(
            "/*\n * old\n */\nconst a = 1;\n", "/*\n * new,\n * longer\n */\nconst a = 1;\n"
        )
        self.assertCommentsOnly("const a = 1;\n", "const a = 1;\n\n// added\n")
        for code in (
            "const r = /\\/\\/[/]/g;",
            "const half = (a + b) / 2 / c;",
            "const half = a[0] / 2;",
            "const a = `${b}/${c}` / 2;",
            "const t = `${ {a: 1}.a + '`' }`;",
            "function f(s) {\n    return /'/.test(s);\n}",
        ):
            self.assertCommentsOnly(code + "\n// old\n", code + "\n// new\n")

    def test_a_tool_directive_is_code(self):
        for old, new in (
            (
                "// Stryker disable next-line all\nx();\n",
                "// Stryker disable next-line all: why\nx();\n",
            ),
            ("x();\n", "// @ts-expect-error\nx();\n"),
            ("x();\n", "/* istanbul ignore next */\nx();\n"),
            ("x();\n", '/// <reference types="node" />\nx();\n'),
            ("x();\n", "// eslint-disable-next-line no-console\nx();\n"),
            ("x();\n", "// prettier-ignore\nx();\n"),
            (
                "/**\n * old\n * @param a the a\n */\nx();\n",
                "/**\n * new\n * @param a the a\n */\nx();\n",
            ),
        ):
            self.assertCode(old, new)

    def test_a_line_with_code_and_a_comment_is_code(self):
        self.assertCode("x(); // old\n", "x(); // new\n")
        self.assertCode("x(/* old */ 1);\n", "x(/* new */ 1);\n")

    def test_a_double_slash_in_a_string_or_a_template_literal_is_code(self):
        self.assertCode('const url = "http://a";\n', 'const url = "http://b";\n')
        self.assertCode("const url = 'http://a';\n", "const url = 'http://b';\n")
        self.assertCode("const text = `\n// old\n`;\n", "const text = `\n// new\n`;\n")
        self.assertCode("const text = `${a}\n    \n`;\n", "const text = `${a}\n  \n`;\n")

    def test_a_comment_that_moves_the_line_a_directive_covers_is_code(self):
        self.assertCode(
            "// Stryker disable next-line all\nfor (;;) {}\n",
            "// Stryker disable next-line all\n// why\nfor (;;) {}\n",
        )
        self.assertCode(
            "// @ts-expect-error\n// old\nx();\n", "// @ts-expect-error\n// new\nx();\n"
        )
        self.assertCode("f(a, b);\n", "f(a, // why\n    b);\n")

    def test_a_comment_that_opens_or_closes_over_code_is_code(self):
        self.assertCode("/* a\nb */\nx();\n", "/* a\nb\nx();\n*/\n")

    def test_what_the_scanner_cannot_tell_is_code(self):
        self.assertCode("/* old\nx();\n", "/* new\nx();\n")
        self.assertCode("const a = 'old;\n", "const a = 'new;\n")
        self.assertCode("const a = 'old\\", "const a = 'new\\")
        self.assertCommentsOnly("const a = 'a\\\nb';\n// old\n", "const a = 'a\\\nb';\n// new\n")
        self.assertCode("if (a) {}\n/x/.test(b);\n// old\n", "if (a) {}\n/x/.test(b);\n// new\n")


BASE_TREE = {
    "src/a.ts": "// note\nexport const a = 1;\n",
    "src/b.ts": "export const b = 1;\n",
    "src/c.ts": "export const c = 1;\n",
    "src/dir/index.ts": "export const d = 1;\n",
    "test/a.spec.ts": 'import { a } from "app/a";\n',
    "test/helper.ts": "export const h = 1;\n",
    "test/c.spec.ts": 'import { c } from "app/c";\n',
    "stryker.config.mjs": "// note\nexport default { timeoutMS: 5000 };\n",
    "package.json": json.dumps(
        {
            "scripts": {"mutation": "stryker run", "lint": "eslint"},
            "devDependencies": {"typescript": "^6.0.3", "eslint": "^9.0.0"},
        }
    ),
    "package-lock.json": json.dumps(
        {
            "packages": {
                "node_modules/typescript": {"version": "6.0.3"},
                "node_modules/eslint": {"version": "9.0.0"},
            }
        }
    ),
    "Makefile": (
        "DC_APP := docker compose -f app.yml\n"
        "DC_APP_RUN := $(DC_APP) run --rm app\n"
        "define NEWLINE\n"
        "\n"
        "\n"
        "endef\n"
        "FILES = $(strip $(subst $(NEWLINE), ,$(files)))\n"
        "LINT := eslint\n"
        "\n"
        "lint: ## Lint\n"
        "\t$(DC_APP_RUN) $(LINT)\n"
        "\n"
        "mutation: ## Mutation testing\n"
        "\t$(DC_APP_RUN) env MUTATE='$(FILES)' node test/mutation-run.ts\n"
    ),
}


def history(*steps):
    """A line of `main` from BASE_TREE: each step is a merge commit and the changes it brings, a
    path mapped to its new text or to None for a deletion."""
    trees = {"base": dict(BASE_TREE)}
    parents = {"base": []}
    previous = "base"
    for commit, changes in steps:
        tree = dict(trees[previous])
        for path, text in changes.items():
            if text is None:
                del tree[path]
            else:
                tree[path] = text
        trees[commit] = tree
        parents[commit] = [previous, commit + "-branch"]
        previous = commit
    return trees, parents, previous


class FakeHistory(FakeGitHub):
    """FakeGitHub with a `main` of commits, each a tree of files: answers git diff, show, ls-tree,
    rev-list and rev-parse HEAD from them, and gh with the files of a PR. The commits behind the
    head are its ancestors."""

    def __init__(self, issues, line, prs, pr_files=None, **failures):
        trees, parents, head = line
        ancestors = []
        commit = head
        while commit in parents:
            ancestors.append(commit)
            commit = (parents[commit] or [None])[0]
        super().__init__(issues, prs=prs, ancestors=ancestors, **failures)
        self.trees = trees
        self.parents = parents
        self.head = head
        self.pr_files = pr_files or {}

    def __call__(self, args, **kwargs):
        answer = self.history_answer(args)
        if answer is None:
            return super().__call__(args, **kwargs)
        self.calls.append(args)
        return subprocess.CompletedProcess(args, 0, answer, "")

    def history_answer(self, args):
        if args[:3] == ["git", "rev-parse", "HEAD"]:
            return self.head + "\n"
        if args[:2] == ["git", "diff"]:
            return self.diff(self.trees[args[-2]], self.trees[args[-1]])
        if args[:2] == ["git", "show"]:
            commit, path = args[2].split(":", 1)
            return self.trees[commit][path]
        if args[:2] == ["git", "ls-tree"]:
            return "\0".join(sorted(self.trees[args[-1]])) + "\0"
        if args[:2] == ["git", "rev-list"] and "--first-parent" in args:
            return self.first_parent_steps(*args[-1].split(".."))
        if args[:2] == ["git", "rev-list"]:
            return " ".join([args[-1]] + self.parents[args[-1]]) + "\n"
        if args[:3] == ["gh", "pr", "view"] and "files" in args:
            return "\n".join(self.pr_files[int(args[3])]) + "\n"
        return None

    def first_parent_steps(self, since, head):
        """Each commit after `since` up to the head with its parents, oldest first."""
        steps = []
        commit = head
        while commit != since:
            steps.append(" ".join([commit] + self.parents[commit]))
            commit = self.parents[commit][0]
        return "".join(step + "\n" for step in reversed(steps))

    def diff(self, old, new):
        deleted = [path for path in old if path not in new]
        added = [path for path in new if path not in old]
        fields = []
        for path in sorted(set(old) & set(new)):
            if old[path] != new[path]:
                fields += ["M", path]
        for path in deleted:
            twin = next((other for other in added if new[other] == old[path]), None)
            if twin is None:
                fields += ["D", path]
            else:
                added.remove(twin)
                fields += ["R100", path, twin]
        for path in added:
            fields += ["A", path]
        return "\0".join(fields) + ("\0" if fields else "")


class BatchFilesTest(unittest.TestCase):
    def github(self, line, records, prs, **kwargs):
        return FakeHistory([batch(630, 1, records=records)], line, prs, **kwargs)

    def files(self, github, batch_issue=630):
        return answer(mutation_batch.print_batch_files, batch_issue, github)

    def one_pr(self, changes, *later):
        """Batch 630 with PR #801, merged as m801 with the changes, and later commits of `main`."""
        line = history(("m801", changes), *later)
        return self.github(line, [(701, 801)], {801: merged("m801")})

    def test_takes_a_source_changed_in_code_and_skips_one_changed_in_comments(self):
        github = self.one_pr(
            {"src/a.ts": "// new note\nexport const a = 1;\n", "src/b.ts": "export const b = 2;\n"}
        )

        code, lines, err = self.files(github)

        self.assertEqual((code, lines), (0, ["src/b.ts"]))
        self.assertIn("PR #801: comments only: src/a.ts\n", err)
        self.assertIn("PR #801: src/b.ts\n", err)

    def test_a_pr_recorded_for_two_issues_is_read_once(self):
        line = history(("m801", {"src/b.ts": "export const b = 2;\n"}))
        github = self.github(line, [(701, 801), (702, 801)], {801: merged("m801")})

        code, lines, err = self.files(github)

        self.assertEqual((code, lines), (0, ["src/b.ts"]))
        self.assertEqual(err.count("PR #801: src/b.ts\n"), 1)

    def test_a_rename_by_the_pr_or_after_it_is_followed_to_the_name_on_main(self):
        github = self.one_pr(
            {
                "src/a.ts": None,
                "src/x.ts": BASE_TREE["src/a.ts"],
                "src/b.ts": "export const b = 2;\n",
            },
            ("m802", {"src/b.ts": None, "src/y.ts": "export const b = 2;\n"}),
        )

        code, lines, _ = self.files(github)

        self.assertEqual((code, lines), (0, ["src/x.ts src/y.ts"]))

    def test_a_file_renamed_and_rewritten_after_the_pr_is_followed_step_by_step(self):
        github = self.one_pr(
            {"src/b.ts": "export const b = 2;\n"},
            ("m802", {"src/b.ts": None, "src/y.ts": "export const b = 2;\n"}),
            ("m803", {"src/y.ts": "export const y = 3;\nexport const z = 4;\n"}),
        )

        code, lines, _ = self.files(github)

        self.assertEqual((code, lines), (0, ["src/y.ts"]))

    def test_a_file_deleted_by_the_pr_or_after_it_is_dropped(self):
        github = self.one_pr(
            {
                "src/c.ts": None,
                "src/a.ts": "export const a = 2;\n",
                "src/b.ts": "export const b = 2;\n",
                "test/helper.ts": 'import { b } from "app/b";\n',
            },
            ("m802", {"src/b.ts": None}),
        )

        code, lines, err = self.files(github)

        self.assertEqual((code, lines), (0, ["src/a.ts"]))
        self.assertEqual(err.count("PR #801: no longer on main: src/b.ts\n"), 1)
        self.assertNotIn("src/c.ts", err)

    def test_a_pr_closed_unmerged_is_skipped_and_one_outside_the_head_left_to_the_carry_over(self):
        line = history(("m804", {"src/b.ts": "export const b = 2;\n"}))
        github = self.github(
            line,
            [(701, 801), (702, 802), (703, 803), (704, 804)],
            {801: CLOSED, 802: OPEN, 803: merged("later"), 804: merged("m804")},
        )

        code, lines, err = self.files(github)

        self.assertEqual((code, lines), (0, ["src/b.ts"]))
        self.assertEqual(
            err.splitlines()[:3],
            [
                "skipped: PR #801, closed without a merge",
                "left to the carry-over: PR #802, not merged",
                "left to the carry-over: PR #803, merged after the run's head",
            ],
        )

    def test_a_changed_spec_or_helper_runs_the_sources_it_imports_through_app(self):
        github = self.one_pr(
            {
                "test/a.spec.ts": (
                    'import { a } from "app/a";\n'
                    "import {\n    d,\n} from 'app/dir';\n"
                    'import { h } from "test/helper";\n'
                    '// import { c } from "app/c";\n'
                ),
                # The scanner gives up on a / after a closing brace, and the imports are read
                # from the text as it is.
                "test/helper.ts": 'import type { B } from "app/b";\nif (h) {}\n/x/.test(b);\n',
            }
        )

        code, lines, err = self.files(github)

        self.assertEqual((code, lines), (0, ["src/a.ts src/b.ts src/dir/index.ts"]))
        self.assertIn("PR #801: test/a.spec.ts -> src/a.ts src/b.ts src/dir/index.ts\n", err)
        self.assertIn("PR #801: test/helper.ts -> src/b.ts\n", err)

    def test_a_deleted_spec_runs_the_sources_it_imported(self):
        github = self.one_pr({"test/c.spec.ts": None})

        code, lines, err = self.files(github)

        self.assertEqual((code, lines), (0, ["src/c.ts"]))
        self.assertIn("PR #801: test/c.spec.ts -> src/c.ts\n", err)

    def test_a_tool_of_the_run_changed_in_code_takes_the_full_run(self):
        package = json.loads(BASE_TREE["package.json"])
        package["devDependencies"]["typescript"] = "^6.1.0"
        lock = json.loads(BASE_TREE["package-lock.json"])
        lock["packages"]["node_modules/typescript"]["version"] = "6.0.4"
        for path, text in (
            ("stryker.config.mjs", "// note\nexport default { timeoutMS: 6000 };\n"),
            ("package.json", json.dumps(package)),
            ("package-lock.json", json.dumps(lock)),
            ("Makefile", BASE_TREE["Makefile"].replace("node test/", "node --inspect test/")),
            ("Makefile", BASE_TREE["Makefile"].replace("run --rm app", "run app")),
            ("Makefile", BASE_TREE["Makefile"].replace("-f app.yml", "-f other.yml")),
            ("Makefile", BASE_TREE["Makefile"].replace("\n\n\nendef", "\n\n \nendef")),
            ("test/mutation-run.ts", "export {};\n"),
        ):
            github = self.one_pr({path: text, "src/b.ts": "export const b = 2;\n"})

            code, lines, err = self.files(github)

            self.assertEqual((code, lines), (0, []), path)
            self.assertIn(
                "full run: PR #801 changed {}, a tool of the run, in more than comments\n".format(
                    path
                ),
                err,
            )

    def test_a_tool_changed_in_comments_or_outside_the_run_keeps_the_list(self):
        package = json.loads(BASE_TREE["package.json"])
        package["devDependencies"]["eslint"] = "^9.1.0"
        package["scripts"]["lint"] = "eslint ."
        lock = json.loads(BASE_TREE["package-lock.json"])
        lock["packages"]["node_modules/eslint"]["version"] = "9.1.0"
        for path, text in (
            ("stryker.config.mjs", "// new note\nexport default { timeoutMS: 5000 };\n"),
            ("package.json", json.dumps(package)),
            ("package-lock.json", json.dumps(lock)),
            ("Makefile", BASE_TREE["Makefile"].replace("LINT := eslint", "LINT := eslint .")),
            ("Makefile", BASE_TREE["Makefile"].replace("## Mutation testing", "## Mutants")),
        ):
            github = self.one_pr({path: text, "src/b.ts": "export const b = 2;\n"})

            code, lines, err = self.files(github)

            self.assertEqual((code, lines), (0, ["src/b.ts"]), path)
            self.assertNotIn("full run", err)

    def test_a_merge_commit_without_the_change_of_the_pr_stops(self):
        line = history(("m801", {"src/b.ts": "export const b = 2;\n"}))
        line[1]["m801"] = ["base"]
        for pr_files, told in (
            (["src/b.ts"], None),
            (["src/a.ts", "src/b.ts"], "does not carry its change of src/a.ts: a rebase merge?"),
        ):
            github = self.github(
                line, [(701, 801)], {801: merged("m801")}, pr_files={801: pr_files}
            )

            code, lines, err = self.files(github)

            if told is None:
                self.assertEqual((code, lines), (0, ["src/b.ts"]))
            else:
                self.assertEqual((code, lines), (1, []))
                self.assertIn(told, err)

    def test_no_file_left_to_mutate_takes_the_full_run(self):
        github = self.one_pr({"src/a.ts": "// new note\nexport const a = 1;\n"})

        code, lines, err = self.files(github)

        self.assertEqual((code, lines), (0, []))
        self.assertIn(
            "full run: no PR of the batch left a file of src/ to mutate on the head\n", err
        )

    def test_no_pr_merged_into_the_head_stops(self):
        github = self.github(history(), [(701, 801)], {801: OPEN})

        code, lines, err = self.files(github)

        self.assertEqual((code, lines), (1, []))
        self.assertIn("Stopped: no PR of the batch is merged into the head", err)

    def test_the_list_writes_nothing(self):
        github = self.one_pr({"src/b.ts": "export const b = 2;\n"})

        self.files(github)

        self.assertEqual(github.called("comment") + github.called("create"), [])
        self.assertEqual(github.lock_held_on_write, [])

    def test_a_number_that_is_no_batch_of_the_viewer_stops(self):
        github = self.one_pr({"src/b.ts": "export const b = 2;\n"})

        code, _, err = self.files(github, batch_issue=650)

        self.assertEqual(code, 1)
        self.assertIn("#650 is no batch", err)


class MainTest(unittest.TestCase):
    def usage(self, *args):
        err = io.StringIO()
        with redirect_stderr(err):
            code = mutation_batch.main(list(args))
        return code, err.getvalue()

    def test_the_arguments_are_checked(self):
        for args in (
            (),
            ("record", "655"),
            ("record", "655", ""),
            ("record", "0", "660"),
            ("record", "655", "#660"),
            ("check", ""),
            ("check", "660", "655"),
            ("close", "630"),
            ("close", "", ""),
            ("close", "630", "#701"),
            ("close", "630", "701", "702"),
            ("files", ""),
            ("files", "630", "631"),
        ):
            code, err = self.usage(*args)

            self.assertEqual(code, 2, args)
            self.assertTrue(re.search(r"usage: make mutation-full-record", err), args)

    def test_the_close_splits_the_issues_of_the_survivors(self):
        for issues, split in (("", []), ("701", [701]), (" 701  702 ", [701, 702])):
            with mock.patch.object(mutation_batch, "close_batch", return_value=0) as close:
                code = mutation_batch.main(["close", "630", issues])

            self.assertEqual(code, 0)
            close.assert_called_once_with(630, split)


if __name__ == "__main__":
    unittest.main()
