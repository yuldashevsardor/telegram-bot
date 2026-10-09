import io
import os
import signal
import subprocess
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import review_run

HEAD = "e810a6c94c4063d8c74248e37b3711404f63dda0"
BATCH_URL = "https://github.com/yuldashevsardor/telegram-bot/issues/662#issuecomment-5812345678"
RECORDED = "recorded: issue #655 — {}\n".format(BATCH_URL)

COMPOSE = (
    "{ [ -e .runtime.env ] || touch .runtime.env; } && docker compose -f docker-compose.app.yml "
    "run --rm app npm run test:coverage\n"
    " Container telegram-bot-review-7-app-run-04ca00b76b1e Creating \n"
    " Container telegram-bot-review-7-app-run-04ca00b76b1e Created \n"
    "\n"
    "> telegram-bot@1.0.0 test:coverage\n"
    "> nyc mocha\n"
    "\n"
)
GREEN_SPECS = COMPOSE + "  \x1b[32m712 passing\x1b[0m (41s)\n\n" + (
    "----------|---------|----------|---------|---------|\n"
    "File      | % Stmts | % Branch | % Funcs | % Lines |\n"
    "All files |     100 |      100 |     100 |     100 |\n"
)
RED_SPECS = COMPOSE + (
    "  710 passing (41s)\n"
    "  2 failing\n"
    "\n"
    "  1) FontForge\n"
    "       converts a font:\n"
    "     AssertionError: expected 1 to equal 2\n"
    "\n"
    "----------|---------|----------|---------|---------|\n"
    "File      | % Stmts | % Branch | % Funcs | % Lines |\n"
    "All files |   99.50 |      100 |     100 |   99.50 |\n"
    "npm notice\n"
    "npm error Lifecycle script `test:coverage` failed with error:\n"
    "npm error code 1\n"
    "npm error path /app\n"
    "make: *** [coverage] Error 1\n"
)
CONVERSION = (
    "{ [ -e .runtime.env ] || touch .runtime.env; } && docker compose -f docker-compose.app.yml "
    "run --rm app npm run test:fonts\n"
    " Container telegram-bot-review-7-app-run-5b1f0c2d9e7a Creating \n"
    " Container telegram-bot-review-7-app-run-5b1f0c2d9e7a Created \n"
    "\n"
    "> telegram-bot@1.0.0 test:fonts\n"
    "> mocha --no-config --require tsx/cjs 'test/conversion/**/*.check.ts'\n"
    "\n"
)
GREEN_CONVERSION = CONVERSION + "  90 passing (25s)\n"
RED_CONVERSION = CONVERSION + (
    "  89 passing (25s)\n"
    "  1 failing\n"
    "\n"
    "  1) conversion\n"
    "       keeps the facts of inter/Inter[opsz,wght].ttf in woff:\n"
    "     AssertionError: unitsPerEm: expected 1000 to equal 2048\n"
    "\n"
    "npm error Lifecycle script `test:fonts` failed with error:\n"
    "npm error code 1\n"
    "make: *** [test-fonts] Error 1\n"
)
RED_BUILD = (
    "{ [ -e .runtime.env ] || touch .runtime.env; } && docker compose -f docker-compose.app.yml "
    "build app\n"
    " Image telegram-bot-review-7-app Building \n"
    "#5 [internal] load metadata for docker.io/library/node:24.20.0-bookworm-slim\n"
    "#5 DONE 1.3s\n"
    "#12 [5/7] RUN npm ci --ignore-scripts\n"
    "#12 3.1 npm error code ETARGET\n"
    "#12 ERROR: process \"/bin/sh -c npm ci --ignore-scripts\" did not complete successfully\n"
    "failed to solve: process \"/bin/sh -c npm ci --ignore-scripts\" did not complete"
    " successfully\n"
    "make: *** [rebuild] Error 1\n"
)


class FakeRun:
    """Stands for subprocess.run: records the calls and answers make, gh and git by the script.

    An answer is (exit code, stdout, stderr), or an exception the call raises.
    """

    def __init__(self, main, review, **answers):
        self.main = main
        self.review = review
        self.answers = {
            "review-tree-create": (
                0,
                "python3 scripts/review/tree_create.py '7'\nTree: {}\nHead: {}\n".format(
                    review, HEAD
                ),
                "",
            ),
            "review-tree-remove": (0, "Cleaned up: {}\n".format(review), ""),
            "mutation-full-check": (0, RECORDED, ""),
            "gh-diff": (0, "", ""),
            "coverage": (0, GREEN_SPECS, ""),
            "test-fonts": (0, GREEN_CONVERSION, ""),
        }
        self.answers.update(answers)
        self.calls = []
        self.kwargs = []

    def __call__(self, args, cwd=None, **kwargs):
        self.calls.append((args, cwd))
        self.kwargs.append((args, kwargs))
        if args[:3] == ["git", "worktree", "list"]:
            listing = "".join(
                "worktree {}\nHEAD 0000000\nbranch refs/heads/x\n\n".format(tree)
                for tree in (self.main,)
            )
            return subprocess.CompletedProcess(args, 0, listing, "")
        answer = self.answers.get(self.name(args), (0, "", ""))
        if isinstance(answer, BaseException):
            raise answer
        code, out, err = answer
        if kwargs.get("stderr") == subprocess.STDOUT:
            return subprocess.CompletedProcess(args, code, out + err, None)
        return subprocess.CompletedProcess(args, code, out, err)

    @staticmethod
    def name(args):
        if args[0] == "gh":
            return "gh-diff"
        return args[1]

    def names(self):
        return [self.name(args) for args, _ in self.calls if args[0] != "git"]


class ReviewRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # realpath: on macOS the temporary directory lies behind the /var -> /private/var symlink.
        root = os.path.realpath(self.tmp.name)
        self.main = os.path.join(root, "telegram-bot")
        self.task = os.path.join(root, "telegram-bot-some-task")
        self.review = os.path.join(root, "telegram-bot-review-7")
        self.logs = os.path.join(root, "logs")
        for tree in (self.main, self.task, self.logs):
            os.makedirs(tree)
        previous = os.getcwd()
        os.chdir(self.task)
        self.addCleanup(os.chdir, previous)

    def fake(self, **answers):
        return FakeRun(self.main, self.review, **answers)

    def review_run(self, gates, run):
        out = io.StringIO()
        with redirect_stdout(out):
            code = review_run.review_run("7", gates.split(), self.logs, run)
        return code, out.getvalue()

    def cwd_of(self, run, name):
        return [cwd for args, cwd in run.calls if args[0] != "git" and run.name(args) == name]

    def test_the_green_path_of_a_code_pr_gives_a_line_per_gate(self):
        run = self.fake()

        code, out = self.review_run(
            "build typecheck lint format-check test docs-sync bug-hunt-high smells mutation-full",
            run,
        )

        self.assertEqual(code, 0)
        self.assertEqual(
            out,
            "Head: {head}\n"
            "Checks\n"
            "rebuild: not needed · build: ok · typecheck: ok · test: ok (712 passing) · lint: ok"
            " · format-check: ok\n"
            "mutation-full: ok — recorded: issue #655 — {batch}\n"
            "Logs: {logs}\n".format(head=HEAD, batch=BATCH_URL, logs=self.logs),
        )
        self.assertEqual(
            run.names(),
            [
                "review-tree-create",
                "build",
                "typecheck",
                "coverage",
                "lint",
                "format-check",
                "mutation-full-check",
                "gh-diff",
                "review-tree-remove",
            ],
        )

    def test_the_gates_run_in_the_tree_of_the_pr_and_the_actions_here(self):
        run = self.fake()

        self.review_run("rebuild build test python mutation-full", run)

        for gate in ("rebuild", "build", "coverage", "review-test"):
            self.assertEqual(self.cwd_of(run, gate), [self.review], gate)
        for action in ("review-tree-create", "mutation-full-check", "review-tree-remove"):
            self.assertEqual(self.cwd_of(run, action), [self.task], action)
        self.assertIn((["make", "review-tree-remove", "path=" + self.review], self.task), run.calls)

    def test_every_output_is_decoded_whatever_bytes_the_pr_brings(self):
        run = self.fake()

        self.review_run("rebuild build test python mutation-full", run)

        for args, kwargs in run.kwargs:
            self.assertEqual(kwargs.get("errors"), "replace", args)

    def test_rebuild_goes_first_whatever_the_order_of_the_gates(self):
        run = self.fake()

        code, out = self.review_run(
            "format-check lint python test-fonts test typecheck build rebuild", run
        )

        self.assertEqual(
            run.names(),
            [
                "review-tree-create",
                "rebuild",
                "build",
                "typecheck",
                "coverage",
                "test-fonts",
                "lint",
                "format-check",
                "review-test",
                "review-tree-remove",
            ],
        )
        self.assertIn(
            "rebuild: done · build: ok · typecheck: ok · test: ok (712 passing)"
            " · test-fonts: ok (90 passing) · lint: ok · format-check: ok · python: ok\n",
            out,
        )

    def test_a_failed_rebuild_stops_the_other_container_gates(self):
        run = self.fake(rebuild=(1, RED_BUILD, ""))

        code, out = self.review_run("rebuild build typecheck test python", run)

        self.assertEqual(
            run.names(), ["review-tree-create", "rebuild", "review-test", "review-tree-remove"]
        )
        self.assertIn(
            "rebuild: fail · build: n-a · typecheck: n-a · test: n-a · python: ok\n"
            "Not run: build, typecheck, test — rebuild failed\n",
            out,
        )
        self.assertIn(
            "Red\n"
            '- make rebuild — #12 3.1 npm error code ETARGET\n'
            "    #12 3.1 npm error code ETARGET\n"
            '    #12 ERROR: process "/bin/sh -c npm ci --ignore-scripts" did not complete'
            " successfully\n"
            '    failed to solve: process "/bin/sh -c npm ci --ignore-scripts" did not complete'
            " successfully\n",
            out,
        )

    def test_a_red_spec_run_gives_its_counts_and_the_tail_from_n_failing(self):
        run = self.fake(coverage=(1, RED_SPECS, ""))

        code, out = self.review_run("build test", run)

        self.assertEqual(code, 0)
        self.assertIn("test: fail (710 passing, 2 failing)\n", out)
        self.assertIn(
            "Red\n"
            "- make coverage — 2 failing\n"
            "      2 failing\n"
            "\n"
            "      1) FontForge\n"
            "           converts a font:\n"
            "         AssertionError: expected 1 to equal 2\n"
            "Logs: ",
            out,
        )
        self.assertEqual(run.names()[-1], "review-tree-remove")
        with open(os.path.join(self.logs, "coverage.log")) as log:
            self.assertEqual(log.read(), RED_SPECS)

    def test_the_conversion_check_runs_in_the_tree_of_the_pr(self):
        run = self.fake()

        code, out = self.review_run("test-fonts", run)

        self.assertEqual(code, 0)
        self.assertEqual(self.cwd_of(run, "test-fonts"), [self.review])
        self.assertEqual(
            out,
            "Head: {}\n"
            "Checks\n"
            "rebuild: not needed · test-fonts: ok (90 passing)\n"
            "Logs: {}\n".format(HEAD, self.logs),
        )

    def test_a_red_conversion_check_makes_the_gate_red_with_the_tail_from_n_failing(self):
        run = self.fake(**{"test-fonts": (1, RED_CONVERSION, "")})

        code, out = self.review_run("test-fonts", run)

        self.assertEqual(code, 0)
        self.assertIn("test-fonts: fail (89 passing, 1 failing)\n", out)
        self.assertIn(
            "Red\n"
            "- make test-fonts — 1 failing\n"
            "      1 failing\n"
            "\n"
            "      1) conversion\n"
            "           keeps the facts of inter/Inter[opsz,wght].ttf in woff:\n"
            "         AssertionError: unitsPerEm: expected 1000 to equal 2048\n"
            "Logs: ",
            out,
        )
        with open(os.path.join(self.logs, "test-fonts.log")) as log:
            self.assertEqual(log.read(), RED_CONVERSION)

    def test_a_long_red_log_is_cut_and_names_the_whole_one(self):
        lines = "".join("src/app.ts:{}:1 error something\n".format(n) for n in range(100))
        run = self.fake(lint=(1, lines, ""))

        code, out = self.review_run("lint", run)

        self.assertIn("- make lint — src/app.ts:60:1 error something\n", out)
        self.assertIn("    src/app.ts:99:1 error something\n", out)
        self.assertNotIn("src/app.ts:59:1", out)
        self.assertIn(
            "    … cut at 40 lines, the whole log: {}\n".format(
                os.path.join(self.logs, "lint.log")
            ),
            out,
        )

    def test_the_rare_gates_and_an_unknown_one_give_not_run_lines_and_run_nothing(self):
        run = self.fake()

        code, out = self.review_run("make-targets scripts lint-fix mutation docs", run)

        self.assertEqual(run.calls, [])
        self.assertEqual(
            out,
            "Checks\n"
            "Not run: make-targets, scripts — by fallback.md\n"
            "Not run: lint-fix, mutation — the review run does not know this gate\n"
            "Logs: {}\n".format(self.logs),
        )

    def test_the_reading_gates_run_nothing_and_give_no_line(self):
        run = self.fake()

        code, out = self.review_run(
            "docs docs-sync comments bug-hunt-high bug-hunt-medium smells", run
        )

        self.assertEqual(run.calls, [])
        self.assertEqual(out, "Checks\nLogs: {}\n".format(self.logs))

    def test_mutation_full_checks_the_batch_without_a_tree(self):
        run = self.fake()

        code, out = self.review_run("mutation-full docs", run)

        self.assertEqual(run.names(), ["mutation-full-check", "gh-diff"])
        self.assertIn((["make", "mutation-full-check", "pr=7"], self.task), run.calls)
        self.assertEqual(
            out,
            "Checks\nmutation-full: ok — recorded: issue #655 — {}\nLogs: {}\n".format(
                BATCH_URL, self.logs
            ),
        )

    def test_an_issue_missing_from_the_batches_is_red(self):
        for answer in (
            "not recorded: no batch records PR #7 with #657, the issues it closes",
            "not recorded: no batch records PR #7, which closes no issue",
        ):
            run = self.fake(**{"mutation-full-check": (0, answer + "\n", "")})

            code, out = self.review_run("mutation-full", run)

            self.assertIn("mutation-full: fail — {}\n".format(answer), out)
            self.assertIn("Red\n- make mutation-full-check — {}\n".format(answer), out)

    def test_an_unanswered_batch_check_is_n_a(self):
        run = self.fake(
            **{"mutation-full-check": (1, "", "Stopped: gh api of the issues failed — HTTP 502\n")}
        )

        code, out = self.review_run("mutation-full", run)

        self.assertIn(
            "mutation-full: n-a — the batch was not checked: gh api of the issues failed — HTTP"
            " 502\n",
            out,
        )
        self.assertNotIn("Red", out)

    def test_neither_a_failed_rebuild_nor_a_stopped_tree_takes_the_batch_check_away(self):
        stopped = (1, "Stopped: a tree of an earlier run is left at {}\n".format(self.review), "")
        for answers in ({"rebuild": (1, RED_BUILD, "")}, {"review-tree-create": stopped}):
            run = self.fake(**answers)

            code, out = self.review_run("rebuild mutation-full", run)

            self.assertIn("mutation-full-check", run.names())
            self.assertIn("mutation-full: ok — recorded: issue #655", out)

    def test_the_new_stryker_marks_go_to_the_reviewer(self):
        diff = (
            "diff --git a/src/a.ts b/src/a.ts\n"
            "--- a/src/a.ts\n"
            "+++ b/src/a.ts\n"
            "@@ -10,3 +10,4 @@ export class A {\n"
            "   one();\n"
            "-  two();\n"
            "+  // Stryker disable next-line StringLiteral: equivalent, the text is not read\n"
            "+  three();\n"
        )
        run = self.fake(**{"gh-diff": (0, diff, "")})

        code, out = self.review_run("mutation-full", run)

        self.assertIn(
            "Yours to read\n"
            "New Stryker disable marks, each to check against its reason:\n"
            "  src/a.ts:11: // Stryker disable next-line StringLiteral: equivalent, the text is"
            " not read\n",
            out,
        )

    def test_a_stopped_tree_gives_every_gate_n_a_and_removes_nothing(self):
        run = self.fake(
            **{
                "review-tree-create": (
                    1,
                    "Not cleaned up: {} — Cannot connect to the Docker daemon\n"
                    "Stopped: a tree of an earlier run is left at {}\n".format(
                        self.review, self.review
                    ),
                    "",
                )
            }
        )

        code, out = self.review_run("build test python", run)

        self.assertEqual(run.names(), ["review-tree-create"])
        why = "the tree was not created: a tree of an earlier run is left at " + self.review
        self.assertIn(
            "rebuild: not needed · build: n-a · test: n-a · python: n-a\n"
            "Not run: build, test, python — {why}\n"
            "Not cleaned up: {tree} — Cannot connect to the Docker daemon\n".format(
                why=why, tree=self.review
            ),
            out,
        )

    def test_a_tree_made_without_env_is_removed(self):
        stop = (
            "Stopped: .env was not copied — [Errno 28] No space left on device; the tree is left,"
            " remove it: make review-tree-remove path={}\n".format(self.review)
        )
        run = self.fake(**{"review-tree-create": (1, stop, "")})

        code, out = self.review_run("build", run)

        self.assertEqual(run.names(), ["review-tree-create", "review-tree-remove"])
        self.assertIn("Not run: build — the tree was not created: .env was not copied", out)

    def test_a_tree_that_was_not_removed_is_named(self):
        run = self.fake(
            **{
                "review-tree-remove": (
                    1,
                    "Not cleaned up: {} — Cannot connect to the Docker daemon\n".format(
                        self.review
                    ),
                    "",
                )
            }
        )

        code, out = self.review_run("build", run)

        self.assertIn(
            "Not cleaned up: {} — Cannot connect to the Docker daemon\n".format(self.review), out
        )

    def test_an_interrupt_during_a_gate_still_removes_the_tree(self):
        for interrupt in (KeyboardInterrupt(), review_run.Interrupted()):
            run = self.fake(coverage=interrupt)

            code, out = self.review_run("build test lint mutation-full", run)

            self.assertEqual(code, 130)
            self.assertEqual(
                run.names(), ["review-tree-create", "build", "coverage", "review-tree-remove"]
            )
            self.assertIn(
                "rebuild: not needed · build: ok · test: n-a · lint: n-a\n"
                "mutation-full: n-a — the run was interrupted\n"
                "Not run: test, lint — the run was interrupted\n",
                out,
            )

    def test_an_interrupt_while_the_tree_is_made_removes_what_it_left(self):
        os.makedirs(self.review)
        run = self.fake(**{"review-tree-create": KeyboardInterrupt()})

        code, out = self.review_run("build", run)

        self.assertEqual(code, 130)
        self.assertEqual(run.names(), ["review-tree-create", "review-tree-remove"])
        self.assertIn((["make", "review-tree-remove", "path=" + self.review], self.task), run.calls)

    def test_an_interrupt_of_a_run_without_a_tree_leaves_the_path_alone(self):
        os.makedirs(self.review)
        run = self.fake(**{"mutation-full-check": KeyboardInterrupt()})

        code, out = self.review_run("mutation-full make-targets", run)

        self.assertEqual(code, 130)
        self.assertEqual(run.names(), ["mutation-full-check"])
        self.assertIn("mutation-full: n-a — the run was interrupted\n", out)

    def test_an_interrupt_after_a_stopped_creation_leaves_the_path_alone(self):
        os.makedirs(self.review)
        run = self.fake(
            **{
                "review-tree-create": (
                    1,
                    "Stopped: a tree of an earlier run is left at {}\n".format(self.review),
                    "",
                ),
                "mutation-full-check": KeyboardInterrupt(),
            }
        )

        code, out = self.review_run("build mutation-full", run)

        self.assertEqual(code, 130)
        self.assertEqual(run.names(), ["review-tree-create", "mutation-full-check"])

    def test_an_interrupt_before_any_tree_removes_nothing(self):
        run = self.fake(**{"review-tree-create": KeyboardInterrupt()})

        code, out = self.review_run("build", run)

        self.assertEqual(run.names(), ["review-tree-create"])

    def test_a_signal_after_the_interrupt_loses_neither_the_cleanup_nor_the_report(self):
        run = self.fake(**{"review-tree-create": KeyboardInterrupt()})
        listed = run.__call__

        # A second Ctrl-C while interrupted() looks for the tree an interrupted creation left.
        def signalled(args, cwd=None, **kwargs):
            if args[0] == "git":
                review_run.on_signal(signal.SIGINT, None)
            return listed(args, cwd, **kwargs)

        os.makedirs(self.review)

        code, out = self.review_run("build", signalled)

        self.assertEqual(code, 130)
        self.assertEqual(run.names(), ["review-tree-create", "review-tree-remove"])
        self.assertIn("Not run: build — the run was interrupted\n", out)
        self.assertFalse(review_run.CLEANING["now"])

    def test_a_signal_is_an_interrupt_except_during_the_cleanup(self):
        with self.assertRaises(review_run.Interrupted):
            review_run.on_signal(signal.SIGTERM, None)
        review_run.CLEANING["now"] = True
        self.addCleanup(review_run.CLEANING.update, now=False)
        review_run.on_signal(signal.SIGTERM, None)


class RunInGroupTest(unittest.TestCase):
    def test_answers_as_subprocess_run(self):
        done = review_run.run_in_group(
            ["sh", "-c", "echo out; echo err >&2; exit 3"], capture_output=True, text=True
        )

        self.assertEqual((done.returncode, done.stdout, done.stderr), (3, "out\n", "err\n"))

    def test_an_interrupt_ends_what_the_command_started(self):
        with tempfile.TemporaryDirectory() as tmp:
            pid_file = os.path.join(tmp, "pid")

            def interrupt(signum, frame):
                raise review_run.Interrupted()

            previous = signal.signal(signal.SIGALRM, interrupt)
            self.addCleanup(signal.signal, signal.SIGALRM, previous)
            signal.setitimer(signal.ITIMER_REAL, 0.5)
            with self.assertRaises(review_run.Interrupted):
                review_run.run_in_group(
                    ["sh", "-c", "sleep 30 & echo $! > {}; wait".format(pid_file)],
                    capture_output=True,
                    text=True,
                )
            with open(pid_file) as file:
                pid = int(file.read())

        # The orphan is reaped by init a moment after the kill; until then it is a zombie.
        for _ in range(50):
            done = subprocess.run(
                ["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True
            )
            if not done.stdout.strip() or done.stdout.strip().startswith("Z"):
                break
            time.sleep(0.1)
        self.assertTrue(not done.stdout.strip() or done.stdout.strip().startswith("Z"), done.stdout)

    def test_an_interrupt_after_the_group_ended_stays_an_interrupt(self):
        def interrupt(signum, frame):
            raise review_run.Interrupted()

        previous = signal.signal(signal.SIGALRM, interrupt)
        self.addCleanup(signal.signal, signal.SIGALRM, previous)
        signal.setitimer(signal.ITIMER_REAL, 0.2)
        with mock.patch.object(review_run.os, "killpg", side_effect=ProcessLookupError()):
            with self.assertRaises(review_run.Interrupted):
                review_run.run_in_group(["sleep", "1"], capture_output=True, text=True)


class ExcerptTest(unittest.TestCase):
    def test_drops_the_progress_the_echo_and_the_make_error_line(self):
        first, lines = review_run.excerpt(
            COMPOSE
            + "src/app.ts\n  1:1  error  'x' is unused\n\nnpm notice\nmake: *** [lint] Error 1\n",
            False,
            "lint.log",
        )

        self.assertEqual(first, "1:1  error  'x' is unused")
        self.assertEqual(lines, ["src/app.ts", "  1:1  error  'x' is unused"])

    def test_without_an_error_word_the_last_line_is_the_first_meaningful(self):
        first, lines = review_run.excerpt(
            "[warn] src/app.ts\n[warn] Code style issues found in the above file.\n",
            False,
            "format-check.log",
        )

        self.assertEqual(first, "[warn] Code style issues found in the above file.")

    def test_keeps_a_pipe_outside_the_specs(self):
        first, lines = review_run.excerpt("[error] > 1 | a | b | c\n", False, "format-check.log")

        self.assertEqual(lines, ["[error] > 1 | a | b | c"])


class NewMarksTest(unittest.TestCase):
    def test_a_mark_outside_the_sources_is_not_one(self):
        diff = (
            "diff --git a/test/a.spec.ts b/test/a.spec.ts\n"
            "+++ b/test/a.spec.ts\n"
            "@@ -1 +1,2 @@\n"
            "+// Stryker disable all\n"
            "diff --git a/docs/a.md b/docs/a.md\n"
            "+++ b/docs/a.md\n"
            "@@ -1 +1,2 @@\n"
            "+a `// Stryker disable` mark\n"
            "diff --git a/src/b.ts b/src/b.ts\n"
            "+++ b/src/b.ts\n"
            "@@ -5,2 +7,3 @@\n"
            " a();\n"
            "\\ No newline at end of file\n"
            "+// Stryker disable next-line all: #600\n"
        )

        self.assertEqual(
            review_run.new_marks(diff), ["src/b.ts:8: // Stryker disable next-line all: #600"]
        )

    def test_a_deleted_file_gives_no_mark(self):
        diff = (
            "diff --git a/src/b.ts b/src/b.ts\n"
            "--- a/src/b.ts\n"
            "+++ /dev/null\n"
            "@@ -1 +0,0 @@\n"
            "-// Stryker disable all\n"
        )

        self.assertEqual(review_run.new_marks(diff), [])


class MainTest(unittest.TestCase):
    def test_forgets_the_variables_of_the_make_above(self):
        environ = {
            "MAKEFLAGS": " -- files=src/app.ts gates=build\\ lint pr=7",
            "MFLAGS": "",
            "MAKELEVEL": "1",
            "files": "src/app.ts",
            "gates": "build lint",
            "pr": "7",
            "HOME": "/home",
        }

        review_run.forget_make(environ)

        self.assertEqual(environ, {"HOME": "/home"})

    def test_rejects_bad_arguments(self):
        for args in (
            ["7", "build"],
            ["x", "build", ""],
            ["0", "build", ""],
            ["7", " ", ""],
            ["7", " , ", ""],
            ["7", "build", "--fix"],
        ):
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                raise SystemExit(review_run.main(args))
            self.assertEqual(raised.exception.code, 2, args)

    def test_commas_whitespace_or_both_give_the_same_gates(self):
        for gates in ("build,typecheck", "build, typecheck", "build typecheck", "build,,typecheck"):
            with mock.patch.object(review_run, "forget_make"), mock.patch.object(
                review_run.signal, "signal"
            ), mock.patch.object(review_run.tempfile, "mkdtemp", return_value="/logs"):
                with mock.patch.object(review_run, "review_run", return_value=0) as run:
                    self.assertEqual(review_run.main(["7", gates, ""]), 0)

            run.assert_called_once_with("7", ["build", "typecheck"], "/logs")


if __name__ == "__main__":
    unittest.main()
