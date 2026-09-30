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
                "threshold reached: the batch is due for its full run",
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
        self.assertEqual(lines[-1], "threshold reached: the batch is due for its full run")

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
            [batch(630, 1, "closed", records=[(640, 641), (655, 656)]), batch(650, 2)],
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
            lines, ["not recorded: no batch records #655, #657, the issues PR #660 closes"]
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


def run_record(head=HEAD, clean="yes", scope="full", exit_code=0, score="100.00"):
    marker = "<!-- mutation-run head={} clean={} scope={} exit={} score={} -->".format(
        head, clean, scope, exit_code, score
    )
    return marker + "\n## `make mutation` run record\n\n- head: `{}`\n".format(head)


class CloseTest(unittest.TestCase):
    def setUp(self):
        self.git_dir = tempfile.mkdtemp(prefix="mutation-batch-")
        self.record_file = os.path.join(self.git_dir, "record.md")
        self.write_run_record(run_record())

    def write_run_record(self, text):
        with open(self.record_file, "w", encoding="utf-8") as file:
            file.write(text)

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
        self.write_run_record(run_record(exit_code=1, score="99.50"))

        self.close(github, survivor_issues=[901, 902])

        self.assertEqual(
            github.issues[630]["comments"][-1]["body"],
            "<!-- mutation-batch-close head={head} -->\n"
            "Closed after the full run on `{head}`.\n"
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

    def test_a_run_record_that_ties_the_run_to_no_full_clean_commit_stops_before_gh(self):
        for text, told in (
            (run_record(scope="files"), "a run over files, not of the whole of src/"),
            (run_record(clean="no"), "ties the run to no commit: clean=no"),
            (run_record(head="unknown", clean="unknown"), "clean=unknown, head=unknown"),
            (run_record(score="none", exit_code=1), "the run broke off before its report"),
            (run_record(exit_code=1, score="99.50"), "the run is red (exit=1)"),
            ("## `make mutation` run record\n", "does not open with the marker of a run record"),
        ):
            self.write_run_record(text)
            github = self.four_prs()

            code, lines, err = self.close(github)

            self.assertEqual((code, lines), (1, []), told)
            self.assertIn(told, err)
            self.assertEqual([github.name(args) for args in github.calls], ["rev-parse"], told)

    def test_no_run_record_stops(self):
        os.remove(self.record_file)

        code, _, err = self.close(self.four_prs())

        self.assertEqual(code, 1)
        self.assertIn("Stopped: no run record at {}".format(self.record_file), err)

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
