import io
import json
import os
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout

import mutation_record

RECORDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "records")


def real(name):
    """A record as it was published in a PR, with the signature under it."""
    with open(os.path.join(RECORDS, name), encoding="utf-8") as file:
        return file.read()


# PR #524: the author's record on the head of the PR, accepted by its review.
PR_524 = real("pr-524.txt")
URL_524 = "https://github.com/yuldashevsardor/telegram-bot/pull/524#issuecomment-5796449019"
HEAD_524 = "e810a6c94c4063d8c74248e37b3711404f63dda0"
AREA_524 = [
    "src/font-convertor/eot-packer/eot-packer.ts",
    "src/font-convertor/font-forge/font-forge.ts",
    "src/font-convertor/signature-matcher/font-signature-matcher.ts",
]

# PR #502: the author's full record on 541d48a, refused by the first review on the head 6e69cfc.
PR_502 = real("pr-502.txt")
URL_502 = "https://github.com/yuldashevsardor/telegram-bot/pull/502#issuecomment-5767969450"
RECORD_HEAD_502 = "541d48a21e01f6ce97f3d2f766ef272a4d67f189"
HEAD_502 = "6e69cfca40185576c176be0243fd801e4c3dc3f5"
# git diff --no-renames --name-only 541d48a 6e69cfc
CHANGED_502 = """.env.dist
CLAUDE.md
README.md
docs/architecture/config.md
docs/architecture/outbound-queue.md
docs/architecture/testing.md
src/bootstrap/config/builder/config-builder.ts
src/bootstrap/config/builder/config-values-builder.ts
src/bootstrap/config/config-values.ts
src/bootstrap/config/container/config-container.ts
src/bootstrap/config/container/config-container.types.ts
src/bootstrap/config/parser/config-parser.ts
src/bootstrap/config/storage/config-env-storage.ts
src/bootstrap/config/storage/config-storage.helper.ts
src/bootstrap/config/storage/config-storage.ts
src/bootstrap/config/storage/file/config-file-storage.ts
src/bootstrap/config/storage/watchable-config-storage.ts
src/telegram/outbound-queue/limit-resolver.ts
src/telegram/outbound-queue/partition.ts
src/telegram/outbound-queue/rate-limit/rate-limit.ts
src/telegram/outbound-queue/runner/runner.ts
src/telegram/outbound-queue/task-queue.ts
src/telegram/outbound-queue/telegram-error.ts
src/telegram/telegram-chat.ts
src/telegram/telegram-limit-resolver.ts
test/bootstrap/config/builder/config-values-builder.spec.ts
test/bootstrap/config/config-container.spec.ts
test/bootstrap/config/parser/config-parser.spec.ts
test/bootstrap/config/storage/config-env-storage.spec.ts
test/bootstrap/config/storage/config-file-storage.helper.ts
test/bootstrap/config/storage/config-file-storage.spec.ts
test/telegram/outbound-queue/runner.spec.ts
test/telegram/outbound-queue/task-queue.spec.ts
"""

SURVIVORS_524 = PR_524.replace(
    "### Survived and uncovered: 0\n",
    "### Survived and uncovered: 2\n\n"
    "- Survived · ConditionalExpression · "
    "`src/font-convertor/font-forge/font-forge.ts:41:13` · `true`\n"
    "- NoCoverage · StringLiteral · `src/font-convertor/eot-packer/eot-packer.ts:12:5` · `\"\"`\n",
).replace("exit=0 score=100.00", "exit=1 score=99.45")


def marker(record, **fields):
    """The record with some fields of its marker replaced."""
    first, rest = record.split("\n", 1)
    for name, value in fields.items():
        head, tail = first.split(" {}=".format(name), 1)
        first = "{} {}={} {}".format(head, name, value, tail.split(" ", 1)[1])
    return first + "\n" + rest


def comment(body, url=URL_524):
    return {"body": body, "url": url}


class FakeRun:
    """Stands for subprocess.run: answers gh with the PR and git with the commits it knows."""

    def __init__(self, comments, head=HEAD_524, commits=(), changed="", **answers):
        self.view = json.dumps({"headRefOid": head, "comments": comments})
        self.commits = set(commits)
        self.changed = changed
        self.answers = answers
        self.calls = []

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        name = args[0] if args[0] == "gh" else args[1]
        if name in self.answers:
            code, output = self.answers[name]
            return subprocess.CompletedProcess(args, code, output if code == 0 else "", output)
        if name == "gh":
            return subprocess.CompletedProcess(args, 0, self.view, "")
        if name == "rev-parse":
            known = args[-1][: -len("^{commit}")] in self.commits
            return subprocess.CompletedProcess(args, 0 if known else 1, "", "")
        return subprocess.CompletedProcess(args, 0, self.changed, "")


class ParseTest(unittest.TestCase):
    def test_the_record_of_pr_524_is_read_whole(self):
        record = mutation_record.parse(URL_524, PR_524)

        self.assertEqual(
            record,
            mutation_record.Record(
                url=URL_524,
                head=HEAD_524,
                clean="yes",
                scope="files",
                exit="0",
                score="100.00",
                files=AREA_524,
                mutated=AREA_524,
                survivors=[],
            ),
        )

    def test_the_full_record_of_pr_502_names_no_files_and_every_mutated_one(self):
        record = mutation_record.parse(URL_502, PR_502)

        self.assertEqual((record.head, record.scope, record.files), (RECORD_HEAD_502, "full", []))
        self.assertEqual(len(record.mutated), 95)
        self.assertEqual(record.mutated[0], "src/bootstrap/application/application.ts")
        self.assertEqual(record.mutated[-1], "src/telegram/user/user.ts")


class MutationRecordTest(unittest.TestCase):
    def answer(self, run, gate="mutation", area=AREA_524, rebuild=False):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = mutation_record.mutation_record("524", gate, area, rebuild, run)
        return code, out.getvalue().splitlines(), err.getvalue()

    def test_the_record_of_pr_524_is_accepted(self):
        code, lines, _ = self.answer(FakeRun([comment(PR_524)]))

        self.assertEqual(code, 0)
        self.assertEqual(
            lines,
            [
                "accepted " + URL_524,
                "head: {} — the PR head".format(HEAD_524),
                "exit: 0",
                "score: 100.00",
                "survivors: 0",
            ],
        )

    def test_the_author_record_of_pr_502_is_refused_for_the_reasons_of_its_review(self):
        run = FakeRun(
            [comment(PR_502, URL_502)],
            head=HEAD_502,
            commits=[RECORD_HEAD_502],
            changed=CHANGED_502,
        )

        code, lines, _ = self.answer(run, gate="mutation-full", area=[], rebuild=True)

        self.assertEqual(code, 0)
        self.assertEqual(lines[0], "refused: " + URL_502)
        self.assertIn("- the rebuild gate is on: the run may have gone on an old image", lines)
        self.assertIn(
            "- the record's head is not the PR head: whether the files changed since stale it "
            "is not decided here",
            lines,
        )
        self.assertIn("  src/telegram/outbound-queue/task-queue.ts", lines)
        self.assertIn("  test/telegram/outbound-queue/task-queue.spec.ts", lines)
        self.assertIn(
            ["git", "diff", "--no-renames", "--name-only", RECORD_HEAD_502, HEAD_502], run.calls
        )

    def test_the_last_record_counts(self):
        older = marker(PR_524, clean="no")
        run = FakeRun([comment(older, "older"), comment("a reply"), comment(PR_524)])

        _, lines, _ = self.answer(run)

        self.assertEqual(lines[0], "accepted " + URL_524)

    def test_a_quoted_marker_is_not_a_record(self):
        quote = "The record says:\n" + PR_524
        other = "<!-- pr-light-check run=1 head=e810a6c -->\n" + PR_524
        run = FakeRun(
            [
                comment(marker(PR_524, clean="no"), "record"),
                comment(quote, "quote"),
                comment(other, "other"),
            ]
        )

        _, lines, _ = self.answer(run)

        self.assertEqual(lines[0], "refused: record")

    def test_no_record_in_the_pr(self):
        code, lines, _ = self.answer(FakeRun([comment("> <!-- mutation-record head=x -->")]))

        self.assertEqual((code, lines), (0, ["refused: no record in the PR"]))

    def test_a_marker_that_is_not_the_wrappers_is_refused(self):
        _, lines, _ = self.answer(FakeRun([comment("<!-- mutation-record head=x -->\n")]))

        self.assertEqual(
            lines,
            [
                "refused: " + URL_524,
                "- the marker is not the wrapper's: <!-- mutation-record head=x -->",
            ],
        )

    def test_condition_1_a_head_that_is_not_in_the_repository_is_refused(self):
        run = FakeRun([comment(PR_524)], head=HEAD_502)

        _, lines, _ = self.answer(run)

        self.assertEqual(
            lines,
            [
                "refused: " + URL_524,
                "- head={}: not a commit of this repository, nothing to compare the PR head {} "
                "with".format(HEAD_524, HEAD_502),
            ],
        )
        self.assertNotIn("diff", [call[1] for call in run.calls])

    def test_condition_1_an_unknown_head_is_refused_without_asking_git(self):
        run = FakeRun([comment(marker(PR_524, head="unknown", clean="unknown"))])

        _, lines, _ = self.answer(run)

        self.assertEqual(lines[0], "refused: " + URL_524)
        self.assertTrue(lines[1].startswith("- head=unknown: not a commit"))
        self.assertEqual(len(run.calls), 1)

    def test_condition_1_different_heads_leave_the_table_to_the_reviewer(self):
        run = FakeRun(
            [comment(PR_524)], head=HEAD_502, commits=[HEAD_524], changed="docs/a.md\nMakefile\n"
        )

        code, lines, _ = self.answer(run)

        self.assertEqual(code, 0)
        self.assertEqual(
            lines,
            [
                "accepted if the table turns on none of rebuild, mutation, mutation-full: "
                + URL_524,
                "changed between the record's head {} and the PR head {}:".format(
                    HEAD_524, HEAD_502
                ),
                "  docs/a.md",
                "  Makefile",
                "the hunk of a file: git diff {} {} -- <file>".format(HEAD_524, HEAD_502),
                "head: {} — not the PR head {}".format(HEAD_524, HEAD_502),
                "exit: 0",
                "score: 100.00",
                "survivors: 0",
            ],
        )

    def test_condition_1_different_heads_with_the_same_tree_are_accepted(self):
        run = FakeRun([comment(PR_524)], head=HEAD_502, commits=[HEAD_524], changed="")

        _, lines, _ = self.answer(run)

        self.assertEqual(lines[0], "accepted " + URL_524)

    def test_condition_2_a_dirty_or_unknown_tree_is_refused(self):
        for clean in ("no", "unknown"):
            _, lines, _ = self.answer(FakeRun([comment(marker(PR_524, clean=clean))]))

            self.assertEqual(
                lines,
                [
                    "refused: " + URL_524,
                    "- clean={}: the run did not go on a clean tree of its commit".format(clean),
                ],
            )

    def test_condition_3_a_run_without_the_report_is_refused(self):
        _, lines, _ = self.answer(FakeRun([comment(marker(PR_524, score="none"))]))

        self.assertEqual(
            lines, ["refused: " + URL_524, "- score=none: the run broke off before the report"]
        )

    def test_condition_3_a_full_record_is_not_taken_under_mutation(self):
        _, lines, _ = self.answer(FakeRun([comment(marker(PR_524, scope="full"))]))

        self.assertIn(
            "- scope=full under the mutation gate: the record's area is not the gate's", lines
        )

    def test_condition_3_a_files_record_is_not_taken_under_mutation_full(self):
        _, lines, _ = self.answer(FakeRun([comment(PR_524)]), gate="mutation-full", area=[])

        self.assertEqual(
            lines,
            [
                "refused: " + URL_524,
                "- scope=files under the mutation-full gate: the record's area is not the gate's",
            ],
        )

    def test_condition_3_a_file_of_the_area_missing_from_the_record_is_refused(self):
        area = AREA_524 + ["src/shared/tokens.ts"]

        _, lines, _ = self.answer(FakeRun([comment(PR_524)]), area=area)

        self.assertEqual(
            lines,
            [
                "refused: " + URL_524,
                "- the record has neither among the mutated files nor in files: "
                "src/shared/tokens.ts",
            ],
        )

    def test_condition_3_a_file_named_in_files_counts_without_mutants(self):
        types = "src/font-convertor/font-convertor.types.ts"
        record = PR_524.replace(
            "- files: `src/font-convertor/eot-packer/eot-packer.ts ",
            "- files: `{} src/font-convertor/eot-packer/eot-packer.ts ".format(types),
        )

        _, lines, _ = self.answer(FakeRun([comment(record)]), area=AREA_524 + [types])

        self.assertEqual(lines[0], "accepted " + URL_524)

    def test_condition_3_a_mutated_file_counts_without_being_named_in_files(self):
        record = PR_524.replace(
            "- files: `src/font-convertor/eot-packer/eot-packer.ts ",
            "- files: `src/font-convertor/** ",
        )

        _, lines, _ = self.answer(FakeRun([comment(record)]))

        self.assertEqual(lines[0], "accepted " + URL_524)

    def test_condition_3_a_cut_off_list_of_survivors_is_refused(self):
        record = SURVIVORS_524.replace(
            "`\"\"`\n",
            "`\"\"`\n- …and 12 more: they did not fit into the record, the full list is in "
            "`reports/mutation/mutation.html` on the machine of the run\n",
        )

        _, lines, _ = self.answer(FakeRun([comment(record)]))

        self.assertEqual(
            lines,
            [
                "refused: " + URL_524,
                "- the list of survivors is cut off: the rest lies only on the machine of the run",
            ],
        )

    def test_condition_4_the_rebuild_gate_refuses(self):
        _, lines, _ = self.answer(FakeRun([comment(PR_524)]), rebuild=True)

        self.assertEqual(
            lines,
            [
                "refused: " + URL_524,
                "- the rebuild gate is on: the run may have gone on an old image",
            ],
        )

    def test_every_reason_is_given_at_once(self):
        record = marker(PR_524, clean="no", scope="full")
        run = FakeRun([comment(record)], head=HEAD_502)

        _, lines, _ = self.answer(run, area=AREA_524 + ["src/shared/tokens.ts"], rebuild=True)

        self.assertEqual(lines[0], "refused: " + URL_524)
        self.assertEqual(
            [line.split(":")[0] for line in lines[1:]],
            [
                "- head={}".format(HEAD_524),
                "- clean=no",
                "- scope=full under the mutation gate",
                "- the record has neither among the mutated files nor in files",
                "- the rebuild gate is on",
            ],
        )

    def test_an_accepted_red_record_hands_over_its_survivors(self):
        _, lines, _ = self.answer(FakeRun([comment(SURVIVORS_524)]))

        self.assertEqual(
            lines[2:],
            [
                "exit: 1",
                "score: 99.45",
                "survivors: 2",
                "- Survived · ConditionalExpression · "
                "`src/font-convertor/font-forge/font-forge.ts:41:13` · `true`",
                "- NoCoverage · StringLiteral · "
                "`src/font-convertor/eot-packer/eot-packer.ts:12:5` · `\"\"`",
            ],
        )

    def test_a_failed_gh_stops_rather_than_refuses(self):
        run = FakeRun([], gh=(1, "HTTP 502: Bad Gateway"))

        code, lines, err = self.answer(run)

        self.assertEqual((code, lines), (1, []))
        self.assertIn("Stopped: gh pr view 524 failed — HTTP 502: Bad Gateway", err)

    def test_a_git_that_did_not_run_stops_rather_than_refuses(self):
        run = FakeRun(
            [comment(PR_524)], head=HEAD_502, **{"rev-parse": (128, "fatal: not a git repository")}
        )

        code, lines, err = self.answer(run)

        self.assertEqual((code, lines), (1, []))
        self.assertIn("Stopped: git rev-parse {} failed".format(HEAD_524), err)

    def test_a_failed_diff_stops(self):
        run = FakeRun(
            [comment(PR_524)], head=HEAD_502, commits=[HEAD_524], diff=(128, "fatal: bad object")
        )

        code, _, err = self.answer(run)

        self.assertEqual(code, 1)
        self.assertIn("Stopped: git diff", err)


class MainTest(unittest.TestCase):
    def usage(self, *args):
        err = io.StringIO()
        with redirect_stderr(err):
            code = mutation_record.main(list(args))
        return code, err.getvalue()

    def test_the_arguments_are_checked(self):
        for args in (
            ("524", "mutation", "src/a.ts"),
            ("0", "mutation", "src/a.ts", ""),
            ("524", "full", "", ""),
            ("524", "mutation", "", ""),
            ("524", "mutation-full", "src/a.ts", ""),
            ("524", "mutation-full", "", "yes"),
        ):
            code, err = self.usage(*args)

            self.assertEqual(code, 2, args)
            self.assertIn("usage: make mutation-record", err)


if __name__ == "__main__":
    unittest.main()
