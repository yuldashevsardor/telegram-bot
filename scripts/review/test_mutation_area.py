import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import mutation_area

DC_APP_RUN = "docker compose -f docker-compose.app.yml run --rm app"

TREE = [
    "src/app.ts",
    "src/shared/config-value.ts",
    "src/font-convertor/eot-packer/eot-packer.ts",
    "src/platform/database/database.ts",
    "src/telegram/session/pgsql-storage.ts",
    "test/shared/config-value.spec.ts",
    "test/font-convertor/eot-packer.spec.ts",
    "test/font-convertor/orphan.spec.ts",
    "test/platform/database/database.spec.ts",
    "test/telegram/session/pgsql-storage.spec.ts",
    "test/database.helper.ts",
    "test/database-hook.ts",
    "test/bootstrap/context.helper.ts",
    "test/bootstrap/config.helper.ts",
    "README.md",
]

CONFIGS = {
    "excluded": [
        "src/app.ts",
        "src/platform/database/database.ts",
        "src/telegram/session/pgsql-storage.ts",
    ],
    "specs": [file for file in TREE if file.endswith(".spec.ts")],
    "aliases": [{"prefix": "app/", "dir": "src/"}, {"prefix": "test/", "dir": "test/"}],
}

# Who imports whom through the test/* alias: the specifier -> the importing files.
IMPORTS = {
    "test/database.helper": [
        "test/platform/database/database.spec.ts",
        "test/telegram/session/pgsql-storage.spec.ts",
    ],
    "test/bootstrap/config.helper": ["test/bootstrap/context.helper.ts"],
    "test/bootstrap/context.helper": ["test/shared/config-value.spec.ts"],
}


# The tree of a PR, other than the tree the action is called from.
PR_TREE = "/review/telegram-bot-review-7"


class FakeRun:
    """Stands for subprocess.run: answers git, gh and the container from the tree above.

    `in_pr_tree` holds the answers that differ when a command runs in PR_TREE.
    """

    def __init__(self, changed, in_pr_tree=None, **answers):
        self.changed = "".join(file + "\n" for file in changed)
        self.answers = {
            "diff": (0, self.changed),
            "gh": (0, self.changed),
            "ls-files": (0, "".join(file + "\n" for file in TREE)),
            "container": (0, " Container app-run Creating\n" + json.dumps(CONFIGS) + "\n"),
        }
        self.answers.update(answers)
        self.in_pr_tree = in_pr_tree or {}
        self.calls = []

    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        name = self.name(args)
        if name == "grep":
            return self.grep(args)
        answers = dict(self.answers)
        if kwargs.get("cwd") == PR_TREE:
            answers.update(self.in_pr_tree)
        code, output = answers[name]
        if code == 0:
            return subprocess.CompletedProcess(args, code, output, "")
        return subprocess.CompletedProcess(args, code, "", output)

    def grep(self, args):
        if "grep" in self.answers:
            code, output = self.answers["grep"]
            return subprocess.CompletedProcess(args, code, "", output)
        specifiers = [args[i + 1].strip("\"'") for i, arg in enumerate(args) if arg == "-e"]
        found = sorted({file for spec in specifiers for file in IMPORTS.get(spec, [])})
        if not found:
            return subprocess.CompletedProcess(args, 1, "", "")
        return subprocess.CompletedProcess(args, 0, "".join(f + "\n" for f in found), "")

    @staticmethod
    def name(args):
        if args[0] == "gh":
            return "gh"
        if args[0] == "sh":
            return "container"
        return args[1]

    def names(self):
        return [self.name(args) for args, _ in self.calls]


class MutationAreaTest(unittest.TestCase):
    def area(self, run, pr=None, tree=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = mutation_area.mutation_area(pr, tree, DC_APP_RUN, run)
        return code, out.getvalue().splitlines(), err.getvalue().splitlines()

    def test_a_source_goes_in_as_it_is(self):
        code, area, notes = self.area(FakeRun(["src/shared/config-value.ts"]))

        self.assertEqual((code, area, notes), (0, ["src/shared/config-value.ts"], []))

    def test_without_a_pr_the_candidates_come_from_the_diff_against_origin_main(self):
        run = FakeRun(["src/shared/config-value.ts"])

        self.area(run)

        self.assertEqual(
            run.calls[0][0], ["git", "diff", "--name-only", "origin/main...HEAD"]
        )

    def test_with_a_pr_the_candidates_come_from_its_diff(self):
        run = FakeRun(["src/shared/config-value.ts"])

        code, area, _ = self.area(run, pr="7")

        self.assertEqual(run.calls[0][0], ["gh", "pr", "diff", "7", "--name-only"])
        self.assertEqual((code, area), (0, ["src/shared/config-value.ts"]))

    def test_without_a_tree_every_command_runs_in_the_current_tree(self):
        run = FakeRun(["test/database.helper.ts"])

        self.area(run, pr="7")

        self.assertEqual(run.names(), ["gh", "ls-files", "container", "grep"])
        self.assertEqual({kwargs["cwd"] for _, kwargs in run.calls}, {None})

    def test_with_a_tree_every_command_runs_in_it(self):
        for pr, diff in (("7", "gh"), (None, "diff")):
            run = FakeRun(["test/database.helper.ts"])

            self.area(run, pr=pr, tree=PR_TREE)

            self.assertEqual(run.names(), [diff, "ls-files", "container", "grep"])
            self.assertEqual({kwargs["cwd"] for _, kwargs in run.calls}, {PR_TREE})

    def test_a_source_the_pr_adds_stays_in_the_area_of_its_tree(self):
        added = "src/shared/added.ts"
        run = FakeRun(
            [added], in_pr_tree={"ls-files": (0, "".join(f + "\n" for f in TREE + [added]))}
        )

        self.assertEqual(self.area(run, pr="7", tree=PR_TREE), (0, [added], []))
        self.assertEqual(
            self.area(run, pr="7"),
            (0, [], ["`{}` is left out: it is not in the tree".format(added)]),
        )

    def test_an_exclusion_only_in_the_stryker_config_of_the_tree_is_subtracted(self):
        configs = dict(CONFIGS, excluded=CONFIGS["excluded"] + ["src/shared/config-value.ts"])
        run = FakeRun(
            ["src/shared/config-value.ts"], in_pr_tree={"container": (0, json.dumps(configs))}
        )

        self.assertEqual(
            self.area(run, pr="7", tree=PR_TREE),
            (0, [], ["`src/shared/config-value.ts` is left out: the Stryker config excludes it"]),
        )
        self.assertEqual(self.area(run, pr="7"), (0, ["src/shared/config-value.ts"], []))

    def test_a_spec_gives_its_mirror(self):
        code, area, notes = self.area(FakeRun(["test/shared/config-value.spec.ts"]))

        self.assertEqual((code, area, notes), (0, ["src/shared/config-value.ts"], []))

    def test_a_spec_without_a_mirror_finds_its_source_by_file_name(self):
        code, area, notes = self.area(FakeRun(["test/font-convertor/eot-packer.spec.ts"]))

        self.assertEqual(
            (code, area, notes), (0, ["src/font-convertor/eot-packer/eot-packer.ts"], [])
        )

    def test_a_spec_without_a_source_gives_no_area_and_says_why(self):
        code, area, notes = self.area(FakeRun(["test/font-convertor/orphan.spec.ts"]))

        self.assertEqual((code, area), (0, []))
        self.assertEqual(
            notes,
            [
                "`test/font-convertor/orphan.spec.ts` gives no area: neither its mirror "
                "`src/font-convertor/orphan.ts` nor a source named `orphan.ts` is in the tree"
            ],
        )

    def test_a_helper_chain_is_followed_to_the_specs_and_their_mirrors(self):
        run = FakeRun(["test/bootstrap/config.helper.ts"])

        code, area, notes = self.area(run)

        self.assertEqual((code, area, notes), (0, ["src/shared/config-value.ts"], []))
        grep = [args for args, _ in run.calls if args[1] == "grep"]
        self.assertEqual(
            grep[0],
            [
                "git", "grep", "-l", "-F",
                "-e", '"test/bootstrap/config.helper"',
                "-e", "'test/bootstrap/config.helper'",
                "--", "test/*.ts",
            ],
        )
        self.assertEqual(len(grep), 2)

    def test_a_hook_nobody_imports_gives_no_area(self):
        code, area, notes = self.area(FakeRun(["test/database-hook.ts"]))

        self.assertEqual((code, area), (0, []))
        self.assertEqual(
            notes, ["`test/database-hook.ts` gives no area: no file under test/ imports it"]
        )

    def test_the_database_helper_gives_the_database_sources_all_of_them_excluded(self):
        code, area, notes = self.area(FakeRun(["test/database.helper.ts"]))

        self.assertEqual((code, area), (0, []))
        self.assertEqual(
            notes,
            [
                "`src/platform/database/database.ts` is left out: the Stryker config excludes it",
                "`src/telegram/session/pgsql-storage.ts` is left out: the Stryker config "
                "excludes it",
            ],
        )

    def test_deleted_paths_are_left_out_and_a_deleted_spec_still_gives_its_mirror(self):
        configs = dict(CONFIGS, specs=CONFIGS["specs"] + ["test/shared/gone.spec.ts"])
        run = FakeRun(
            ["src/shared/gone.ts", "test/shared/gone.spec.ts", "test/shared/config-value.spec.ts"],
            container=(0, json.dumps(configs)),
        )

        code, area, notes = self.area(run)

        self.assertEqual((code, area), (0, ["src/shared/config-value.ts"]))
        self.assertEqual(
            notes,
            [
                "`src/shared/gone.ts` is left out: it is not in the tree",
                "`test/shared/gone.spec.ts` gives no area: neither its mirror "
                "`src/shared/gone.ts` nor a source named `gone.ts` is in the tree",
            ],
        )

    def test_the_exclusions_of_the_stryker_config_are_subtracted(self):
        code, area, notes = self.area(FakeRun(["src/app.ts", "src/shared/config-value.ts"]))

        self.assertEqual((code, area), (0, ["src/shared/config-value.ts"]))
        self.assertEqual(notes, ["`src/app.ts` is left out: the Stryker config excludes it"])

    def test_a_diff_without_ts_under_src_or_test_asks_no_container(self):
        run = FakeRun(["README.md", "migrations/1-init.ts", "scripts/review/tree_create.py"])

        code, area, notes = self.area(run)

        self.assertEqual((code, area), (0, []))
        self.assertEqual(notes, ["the diff has no .ts under src/ or test/"])
        self.assertEqual(run.names(), ["diff"])

    def test_the_container_gets_the_script_on_stdin_and_the_changed_ts_as_arguments(self):
        run = FakeRun(["src/shared/config-value.ts", "test/a b.spec.ts", "README.md"])

        self.area(run)

        args = next(args for args, _ in run.calls if args[0] == "sh")
        self.assertEqual(
            args,
            [
                "sh",
                "-c",
                DC_APP_RUN
                + " node --input-type=module - src/shared/config-value.ts 'test/a b.spec.ts'"
                + " < "
                + mutation_area.CONFIGS_SCRIPT,
            ],
        )
        self.assertTrue(os.path.isfile(mutation_area.CONFIGS_SCRIPT))

    def test_a_failed_git_diff_is_an_error_not_an_empty_area(self):
        code, area, notes = self.area(FakeRun([], diff=(128, "fatal: bad revision")))

        self.assertEqual((code, area), (1, []))
        self.assertEqual(
            notes,
            [
                "Stopped: git diff --name-only origin/main...HEAD failed — "
                "fatal: bad revision"
            ],
        )

    def test_a_failed_gh_is_an_error_not_an_empty_area(self):
        code, area, notes = self.area(
            FakeRun([], gh=(1, "could not find pull request")), pr="7"
        )

        self.assertEqual((code, area), (1, []))
        self.assertEqual(
            notes, ["Stopped: gh pr diff 7 --name-only failed — could not find pull request"]
        )

    def test_a_failed_container_is_an_error_not_an_empty_area(self):
        run = FakeRun(
            ["src/shared/config-value.ts"],
            container=(1, "Error response from daemon: network not found"),
        )

        code, area, notes = self.area(run)

        self.assertEqual((code, area), (1, []))
        self.assertEqual(
            notes,
            [
                "Stopped: the configs were not read in the application container — "
                "Error response from daemon: network not found"
            ],
        )

    def test_a_container_that_prints_no_configs_is_an_error(self):
        run = FakeRun(["src/shared/config-value.ts"], container=(0, "\n"))

        code, area, notes = self.area(run)

        self.assertEqual((code, area), (1, []))
        self.assertTrue(
            notes[0].startswith("Stopped: the application container answered with no configs")
        )

    def test_a_failed_git_ls_files_is_an_error(self):
        run = FakeRun(
            ["src/shared/config-value.ts"], **{"ls-files": (128, "fatal: not a git repository")}
        )

        code, area, notes = self.area(run)

        self.assertEqual((code, area), (1, []))
        self.assertEqual(notes, ["Stopped: git ls-files failed — fatal: not a git repository"])

    def test_a_failed_git_grep_is_an_error(self):
        run = FakeRun(["test/database.helper.ts"], grep=(2, "fatal: bad pathspec"))

        code, area, notes = self.area(run)

        self.assertEqual((code, area), (1, []))
        self.assertEqual(
            notes,
            ["Stopped: git grep for the importers of test/database.helper.ts failed — "
             "fatal: bad pathspec"],
        )


class MainTest(unittest.TestCase):
    def call(self, argv, environ):
        err = io.StringIO()
        with redirect_stderr(err):
            code = mutation_area.main(argv, environ)
        return code, err.getvalue().strip()

    def test_refuses_anything_but_a_pr_number_and_a_tree(self):
        for argv in (["abc", ""], ["0", ""], ["7"], ["7", "", ""], []):
            self.assertEqual(
                self.call(argv, {"DC_APP_RUN": DC_APP_RUN}),
                (2, "usage: make mutation-area [pr=<N>] [tree=<path>]"),
            )

    def test_refuses_to_run_outside_make(self):
        self.assertEqual(
            self.call(["", ""], {}), (2, "Stopped: no DC_APP_RUN — run it as make mutation-area")
        )

    def test_refuses_a_tree_that_is_not_a_directory(self):
        self.assertEqual(
            self.call(["7", "/nonexistent/tree"], {"DC_APP_RUN": DC_APP_RUN}),
            (2, "Stopped: /nonexistent/tree is not a directory"),
        )

    def test_empty_arguments_mean_no_pr_and_no_tree(self):
        with tempfile.TemporaryDirectory() as tree, mock.patch.object(
            mutation_area, "mutation_area", return_value=0
        ) as called:
            for argv, expected in (
                (["", ""], (None, None)),
                (["7", ""], ("7", None)),
                (["", tree], (None, tree)),
                (["7", tree], ("7", tree)),
            ):
                self.assertEqual(self.call(argv, {"DC_APP_RUN": DC_APP_RUN}), (0, ""))
                self.assertEqual(called.call_args.args, expected + (DC_APP_RUN,))


if __name__ == "__main__":
    unittest.main()
