import io
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

import tree_create
import tree_remove

HEAD = "0123456789abcdef0123456789abcdef01234567"


class FakeRun:
    """Stands for subprocess.run: records the calls and answers make, gh, git and docker by the script."""

    def __init__(self, worktrees, **answers):
        self.worktrees = worktrees
        self.answers = {
            "db-up": (0, ""),
            "gh": (0, HEAD + "\n"),
            "cat-file": (0, ""),
            "fetch": (0, ""),
            "down": (0, ""),
            "remove": (0, ""),
            "add": (0, ""),
        }
        self.answers.update(answers)
        self.calls = []

    def __call__(self, args, cwd=None, **kwargs):
        self.calls.append((args, cwd))
        if args[:3] == ["git", "worktree", "list"]:
            listing = "".join(
                "worktree {}\nHEAD 0000000\nbranch refs/heads/x\n\n".format(tree)
                for tree in self.worktrees
            )
            return subprocess.CompletedProcess(args, 0, listing, "")
        name = self.name(args)
        code, output = self.answers[name]
        if name == "gh":
            return subprocess.CompletedProcess(args, code, output if code == 0 else "", output)
        if name == "add" and code == 0:
            os.makedirs(args[4])
        return subprocess.CompletedProcess(args, code, "", output)

    @staticmethod
    def name(args):
        if args[0] == "make":
            return args[1]
        if args[0] == "gh":
            return "gh"
        if args[0] == "docker":
            return "down"
        if args[1] == "worktree":
            return args[2]
        return args[1]

    def names(self):
        return [self.name(args) for args, _ in self.calls if args[:3] != ["git", "worktree", "list"]]


class CreateTreeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # realpath: on macOS the temporary directory lies behind the /var -> /private/var symlink.
        root = os.path.realpath(self.tmp.name)
        self.main = os.path.join(root, "telegram-bot")
        self.task = os.path.join(root, "telegram-bot-some-task")
        self.review = os.path.join(root, "telegram-bot-review-7")
        for tree in (self.main, self.task):
            os.makedirs(tree)
        with open(os.path.join(self.task, ".env"), "w") as env:
            env.write("BOT_TOKEN=secret\n")
        previous = os.getcwd()
        os.chdir(self.task)
        self.addCleanup(os.chdir, previous)

    def create(self, run):
        out = io.StringIO()
        with redirect_stdout(out):
            code = tree_create.create_tree("7", run)
        return code, out.getvalue().strip()

    def run_on(self, **answers):
        return FakeRun([self.main, self.task], **answers)

    def test_brings_the_database_up_here_and_creates_a_detached_tree_of_the_head(self):
        run = self.run_on()

        code, out = self.create(run)

        self.assertEqual(code, 0)
        self.assertEqual(out, "Tree: {}\nHead: {}".format(self.review, HEAD))
        self.assertEqual(run.calls[0], (["make", "db-up"], self.task))
        self.assertIn(
            (["gh", "pr", "view", "7", "--json", "headRefOid", "-q", ".headRefOid"], None),
            run.calls,
        )
        self.assertEqual(run.names(), ["db-up", "gh", "cat-file", "add"])
        self.assertEqual(
            run.calls[-1], (["git", "worktree", "add", "--detach", self.review, HEAD], None)
        )
        with open(os.path.join(self.review, ".env")) as env:
            self.assertEqual(env.read(), "BOT_TOKEN=secret\n")

    def test_without_env_stops_before_anything_runs(self):
        os.remove(os.path.join(self.task, ".env"))
        run = self.run_on()

        code, out = self.create(run)

        self.assertEqual(code, 1)
        self.assertEqual(
            out, "Stopped: no .env in {} — run make worktree-init there".format(self.task)
        )
        self.assertEqual(run.calls, [])

    def test_a_failed_db_up_stops_with_its_reason(self):
        run = self.run_on(**{"db-up": (2, "Cannot connect to the Docker daemon\n")})

        code, out = self.create(run)

        self.assertEqual(code, 1)
        self.assertEqual(
            out, "Stopped: make db-up failed — Cannot connect to the Docker daemon"
        )
        self.assertEqual(run.names(), ["db-up"])

    def test_a_failed_gh_stops_with_its_reason(self):
        run = self.run_on(gh=(1, "GraphQL: Could not resolve to a PullRequest\n"))

        code, out = self.create(run)

        self.assertEqual(code, 1)
        self.assertEqual(
            out,
            "Stopped: gh pr view 7 failed — GraphQL: Could not resolve to a PullRequest",
        )
        self.assertEqual(run.names(), ["db-up", "gh"])

    def test_an_empty_head_from_gh_stops(self):
        run = self.run_on(gh=(0, "\n"))

        code, out = self.create(run)

        self.assertEqual(code, 1)
        self.assertEqual(out, "Stopped: gh pr view 7 named no head")
        self.assertEqual(run.names(), ["db-up", "gh"])

    def test_a_missing_commit_is_fetched_by_its_hash_without_writing_a_ref(self):
        run = self.run_on(**{"cat-file": (1, "")})

        code, _ = self.create(run)

        self.assertEqual(code, 0)
        self.assertEqual(run.names(), ["db-up", "gh", "cat-file", "fetch", "add"])
        self.assertIn(
            (["git", "cat-file", "-e", HEAD + "^{commit}"], None), run.calls
        )
        self.assertIn(
            (["git", "fetch", "--quiet", "--no-write-fetch-head", "origin", HEAD], None),
            run.calls,
        )

    def test_a_failed_fetch_stops_with_its_reason(self):
        run = self.run_on(
            **{"cat-file": (1, ""), "fetch": (128, "fatal: unable to access origin\n")}
        )

        code, out = self.create(run)

        self.assertEqual(code, 1)
        self.assertEqual(
            out,
            "Stopped: could not fetch {} from origin — fatal: unable to access origin".format(
                HEAD
            ),
        )
        self.assertEqual(run.names(), ["db-up", "gh", "cat-file", "fetch"])

    def test_a_tree_left_by_an_earlier_run_is_removed_first(self):
        os.makedirs(self.review)
        run = FakeRun([self.main, self.task, self.review])
        # The fake remove leaves the directory; the real git worktree remove deletes it.
        real = run.__call__

        def removing(args, cwd=None, **kwargs):
            done = real(args, cwd, **kwargs)
            if args[:3] == ["git", "worktree", "remove"]:
                os.rmdir(self.review)
            return done

        code, out = self.create(removing)

        self.assertEqual(code, 0)
        self.assertEqual(
            run.names(), ["db-up", "gh", "cat-file", "down", "remove", "add"]
        )
        self.assertIn((tree_remove.DOWN, self.review), run.calls)
        self.assertEqual(
            out.splitlines(),
            ["Cleaned up: " + self.review, "Tree: " + self.review, "Head: " + HEAD],
        )

    def test_a_leftover_tree_that_is_not_removed_stops_and_is_named(self):
        os.makedirs(self.review)
        run = FakeRun(
            [self.main, self.task, self.review],
            down=(1, "Cannot connect to the Docker daemon\n"),
        )

        code, out = self.create(run)

        self.assertEqual(code, 1)
        self.assertEqual(
            out.splitlines(),
            [
                "Not cleaned up: {} — Cannot connect to the Docker daemon".format(self.review),
                "Stopped: a tree of an earlier run is left at " + self.review,
            ],
        )
        self.assertEqual(run.names(), ["db-up", "gh", "cat-file", "down"])

    def test_a_leftover_directory_that_is_not_a_review_tree_stops_and_is_named(self):
        os.makedirs(self.review)
        run = self.run_on()

        code, out = self.create(run)

        self.assertEqual(code, 1)
        self.assertEqual(
            out.splitlines()[-1],
            "Stopped: a tree of an earlier run is left at " + self.review,
        )
        self.assertEqual(run.names(), ["db-up", "gh", "cat-file"])

    def test_a_failed_worktree_add_stops_with_its_reason(self):
        run = self.run_on(add=(128, "fatal: invalid reference: {}\n".format(HEAD)))

        code, out = self.create(run)

        self.assertEqual(code, 1)
        self.assertEqual(
            out,
            "Stopped: git worktree add {} failed — fatal: invalid reference: {}".format(
                self.review, HEAD
            ),
        )

    def test_a_failed_env_copy_names_the_tree_left_behind(self):
        run = self.run_on()
        real = run.__call__

        def without_directory(args, cwd=None, **kwargs):
            done = real(args, cwd, **kwargs)
            if args[:3] == ["git", "worktree", "add"]:
                os.rmdir(self.review)
            return done

        code, out = self.create(without_directory)

        self.assertEqual(code, 1)
        self.assertTrue(out.startswith("Stopped: .env was not copied — "), out)
        self.assertTrue(
            out.endswith(
                "; the tree is left, remove it: make review-tree-remove path=" + self.review
            ),
            out,
        )

    def test_the_path_follows_the_name_of_the_main_worktree(self):
        root = os.path.dirname(self.main)
        main = os.path.join(root, "fonts")
        os.makedirs(main)

        code, out = self.create(FakeRun([main, self.task]))

        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines()[0], "Tree: " + os.path.join(root, "fonts-review-7"))

    def test_a_failed_worktree_list_stops_with_its_reason(self):
        run = self.run_on()
        real = run.__call__

        def failing_list(args, cwd=None, **kwargs):
            if args[:3] == ["git", "worktree", "list"]:
                return subprocess.CompletedProcess(args, 128, "", "fatal: not a git repository\n")
            return real(args, cwd, **kwargs)

        code, out = self.create(failing_list)

        self.assertEqual(code, 1)
        self.assertEqual(
            out, "Stopped: git worktree list failed: fatal: not a git repository"
        )


    def test_an_empty_worktree_list_stops(self):
        run = FakeRun([])

        code, out = self.create(run)

        self.assertEqual(code, 1)
        self.assertEqual(out, "Stopped: git worktree list named no worktree")
        self.assertEqual(run.names(), ["db-up", "gh", "cat-file"])


class MainTest(unittest.TestCase):
    def test_asks_for_exactly_one_pr_number(self):
        for argv in ([], [""], ["7", "8"], ["07"], ["0"], ["7a"], ["../x"], ["²"]):
            err = io.StringIO()
            with self.subTest(argv=argv), redirect_stderr(err):
                self.assertEqual(tree_create.main(argv), 2)
                self.assertIn("make review-tree-create pr=<N>", err.getvalue())


if __name__ == "__main__":
    unittest.main()
