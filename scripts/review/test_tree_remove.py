import io
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

import tree_remove


class FakeRun:
    """Stands for subprocess.run: records the calls and answers docker and git by the script."""

    def __init__(self, worktrees, down=(0, ""), remove=(0, "")):
        self.worktrees = worktrees
        self.answers = {"down": down, "remove": remove}
        self.calls = []

    def __call__(self, args, cwd=None, **kwargs):
        self.calls.append((args, cwd))
        if args[:3] == ["git", "worktree", "list"]:
            listing = "".join(
                "worktree {}\nHEAD 0000000\nbranch refs/heads/x\n\n".format(tree)
                for tree in self.worktrees
            )
            return subprocess.CompletedProcess(args, 0, listing, "")
        name = "down" if args[0] == "docker" else "remove"
        code, stderr = self.answers[name]
        return subprocess.CompletedProcess(args, code, "", stderr)

    def commands(self):
        return [args[:3] for args, _ in self.calls if args[:3] != ["git", "worktree", "list"]]


class RemoveTreeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # realpath: on macOS the temporary directory lies behind the /var -> /private/var symlink.
        root = os.path.realpath(self.tmp.name)
        self.main = os.path.join(root, "telegram-bot")
        self.review = os.path.join(root, "telegram-bot-review-7")
        self.task = os.path.join(root, "telegram-bot-review-tooling")
        for tree in (self.main, self.review, self.task):
            os.makedirs(os.path.join(tree, "tmp"))
        os.symlink(os.path.join(self.main, "tmp"), os.path.join(self.task, "tmp", "pgsql"))

    def remove(self, path, run):
        out = io.StringIO()
        with redirect_stdout(out):
            code = tree_remove.remove_tree(path, run)
        return code, out.getvalue().strip()

    def test_takes_the_application_down_from_the_tree_then_removes_it_from_the_main_one(self):
        run = FakeRun([self.main, self.review])

        code, out = self.remove(self.review, run)

        self.assertEqual(code, 0)
        self.assertEqual(out, "Cleaned up: " + self.review)
        self.assertEqual(
            run.calls[1:],
            [
                (tree_remove.DOWN, self.review),
                (["git", "worktree", "remove", "--force", self.review], self.main),
            ],
        )
        self.assertIn("--remove-orphans", tree_remove.DOWN)

    def test_a_failed_down_keeps_the_tree_and_names_the_error(self):
        run = FakeRun(
            [self.main, self.review],
            down=(
                1,
                " Container telegram-bot-review-7-app-run-1  Stopping\n"
                "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n",
            ),
        )

        code, out = self.remove(self.review, run)

        self.assertEqual(code, 1)
        self.assertEqual(
            out,
            "Not cleaned up: {} — Cannot connect to the Docker daemon at "
            "unix:///var/run/docker.sock.".format(self.review),
        )
        self.assertEqual(run.commands(), [tree_remove.DOWN[:3]])

    def test_a_failed_remove_names_the_error(self):
        run = FakeRun(
            [self.main, self.review],
            remove=(128, "fatal: '{}' is locked\n".format(self.review)),
        )

        code, out = self.remove(self.review, run)

        self.assertEqual(code, 1)
        self.assertEqual(
            out, "Not cleaned up: {0} — fatal: '{0}' is locked".format(self.review)
        )

    def test_an_error_without_a_known_word_is_named_by_its_last_line(self):
        run = FakeRun([self.main, self.review], down=(1, "first\nsecond\n\n"))

        _, out = self.remove(self.review, run)

        self.assertEqual(out, "Not cleaned up: {} — second".format(self.review))

    def test_a_silent_failure_is_named_by_its_exit_code(self):
        run = FakeRun([self.main, self.review], down=(3, ""))

        _, out = self.remove(self.review, run)

        self.assertEqual(out, "Not cleaned up: {} — exit code 3".format(self.review))

    def assertRefused(self, path, worktrees, why):
        run = FakeRun(worktrees)

        code, out = self.remove(path, run)

        self.assertEqual(code, 2)
        self.assertEqual(
            out, "Refused: {} is not a temporary review tree — {}".format(path, why)
        )
        self.assertEqual(run.commands(), [])

    def test_refuses_the_main_worktree(self):
        self.assertRefused(
            self.main, [self.main, self.review], "it is the main worktree"
        )

    def test_refuses_a_directory_that_is_not_a_worktree(self):
        self.assertRefused(
            self.review, [self.main], "it is not a worktree of this repository"
        )

    def test_refuses_a_review_tree_elsewhere(self):
        elsewhere = os.path.join(self.main, "telegram-bot-review-7")
        os.makedirs(elsewhere)
        self.assertRefused(
            elsewhere,
            [self.main, elsewhere],
            "it does not lie next to the main worktree " + self.main,
        )

    def test_refuses_a_worktree_with_another_name(self):
        other = os.path.join(os.path.dirname(self.main), "telegram-bot-552-task")
        os.makedirs(other)
        self.assertRefused(
            other,
            [self.main, other],
            "its name does not start with telegram-bot-review-",
        )

    def test_refuses_a_task_worktree_named_like_a_review_tree(self):
        self.assertRefused(
            self.task,
            [self.main, self.task],
            "it has the tmp/pgsql symlink of make worktree-init, so it is a task worktree",
        )

    def test_a_relative_path_is_resolved(self):
        run = FakeRun([self.main, self.review])
        previous = os.getcwd()
        os.chdir(self.main)
        self.addCleanup(os.chdir, previous)

        code, _ = self.remove("../telegram-bot-review-7", run)

        self.assertEqual(code, 0)
        self.assertEqual(run.calls[1], (tree_remove.DOWN, self.review))

    def test_the_prefix_follows_the_name_of_the_main_worktree(self):
        root = os.path.dirname(self.main)
        main = os.path.join(root, "fonts")
        review = os.path.join(root, "fonts-review-7")
        for tree in (main, review):
            os.makedirs(tree)

        code, _ = self.remove(review, FakeRun([main, review]))
        self.assertEqual(code, 0)

        self.assertRefused(
            self.review,
            [main, self.review],
            "its name does not start with fonts-review-",
        )


class MainTest(unittest.TestCase):
    def test_asks_for_exactly_one_path(self):
        for argv in ([], [""], ["a", "b"]):
            err = io.StringIO()
            with self.subTest(argv=argv), redirect_stderr(err):
                self.assertEqual(tree_remove.main(argv), 2)
                self.assertIn("make review-tree-remove path=<tree>", err.getvalue())


if __name__ == "__main__":
    unittest.main()
