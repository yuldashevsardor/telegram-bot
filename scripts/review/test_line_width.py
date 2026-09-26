import io
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

import line_width

LONG = "x" * 101
FULL = "x" * 100


class AddedLinesTest(unittest.TestCase):
    def test_takes_the_numbers_of_the_new_side(self):
        patch = "\n".join([
            "diff --git a/a.md b/a.md",
            "--- a/a.md",
            "+++ b/a.md",
            "@@ -3,2 +3 @@",
            "-old",
            "-old",
            "+new",
            "@@ -10,0 +11,2 @@",
            "+new",
            "+new",
            "diff --git a/b.py b/b.py",
            "--- /dev/null",
            "+++ b/b.py",
            "@@ -0,0 +1,2 @@",
            "+one",
            "+two",
        ])
        self.assertEqual(line_width.added_lines(patch), {"a.md": {3, 11, 12}, "b.py": {1, 2}})

    def test_an_added_line_that_looks_like_a_header_is_a_line(self):
        patch = "\n".join([
            "--- a/a.md",
            "+++ b/a.md",
            "@@ -1,0 +2,2 @@",
            "+++ b/other.md",
            "+@@ -1 +1 @@",
        ])
        self.assertEqual(line_width.added_lines(patch), {"a.md": {2, 3}})

    def test_a_removed_line_that_looks_like_a_header_is_a_line(self):
        patch = "\n".join([
            "--- a/a.md",
            "+++ b/a.md",
            "@@ -1 +1 @@",
            "--- a/other.md",
            "+new",
        ])
        self.assertEqual(line_width.added_lines(patch), {"a.md": {1}})

    def test_the_marker_of_a_missing_newline_counts_as_no_line(self):
        patch = "\n".join([
            "--- a/a.md",
            "+++ b/a.md",
            "@@ -1 +1,2 @@",
            "-old",
            "\\ No newline at end of file",
            "+new",
            "+new",
            "\\ No newline at end of file",
        ])
        self.assertEqual(line_width.added_lines(patch), {"a.md": {1, 2}})

    def test_a_line_break_inside_a_line_does_not_split_it(self):
        patch = "--- a/a.md\n+++ b/a.md\n@@ -0,0 +1,2 @@\n+one half\n+two\n"
        self.assertEqual(line_width.added_lines(patch), {"a.md": {1, 2}})

    def test_a_deleted_file_gives_nothing(self):
        patch = "--- a/a.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n"
        self.assertEqual(line_width.added_lines(patch), {})

    def test_a_quoted_name_and_the_tab_after_a_spaced_name(self):
        patch = "\n".join([
            '+++ "b/a\\"b.md"',
            "@@ -0,0 +1 @@",
            "+new",
            "+++ b/c d.md\t",
            "@@ -0,0 +1 @@",
            "+new",
        ])
        self.assertEqual(line_width.added_lines(patch), {'a"b.md': {1}, "c d.md": {1}})


class ExemptMarkdownTest(unittest.TestCase):
    def test_frontmatter_runs_to_its_closing_line(self):
        lines = ["---", "name: x", "---", "text", "---"]
        self.assertEqual(line_width.exempt_markdown(lines), {1, 2, 3})

    def test_a_rule_past_the_first_line_is_no_frontmatter(self):
        self.assertEqual(line_width.exempt_markdown(["text", "---", "text", "---"]), set())

    def test_a_fence_covers_its_lines_and_both_fences(self):
        lines = ["text", "  ```bash", "code", "```", "text"]
        self.assertEqual(line_width.exempt_markdown(lines), {2, 3, 4})

    def test_a_fence_closes_only_by_its_own_character_and_length(self):
        lines = ["````", "```", "~~~~", "````` ", "text"]
        self.assertEqual(line_width.exempt_markdown(lines), {1, 2, 3, 4})

    def test_a_closing_fence_carries_no_info(self):
        lines = ["~~~", "~~~ text", "~~~", "text"]
        self.assertEqual(line_width.exempt_markdown(lines), {1, 2, 3})

    def test_a_backtick_in_the_info_is_no_fence(self):
        self.assertEqual(line_width.exempt_markdown(["``` a`b", "text"]), set())

    def test_a_block_left_open_runs_to_the_end(self):
        self.assertEqual(line_width.exempt_markdown(["text", "```", "code", "code"]), {2, 3, 4})

    def test_a_table_row_is_exempt(self):
        lines = ["| a | b |", "| --- | --- |", "  | c | d |", "a | b"]
        self.assertEqual(line_width.exempt_markdown(lines), {1, 2, 3})

    def test_no_lines(self):
        self.assertEqual(line_width.exempt_markdown([]), set())


class TooLongTest(unittest.TestCase):
    def test_the_limit_is_100_characters(self):
        self.assertEqual(line_width.too_long("a.py", [FULL, LONG], {1, 2}), [2])

    def test_a_column_is_a_character(self):
        self.assertEqual(line_width.too_long("a.md", ["я" * 100, "я" * 101], {1, 2}), [2])

    def test_only_the_given_lines(self):
        self.assertEqual(line_width.too_long("a.sh", [LONG, LONG], {2}), [2])

    def test_markdown_exemptions_apply_to_markdown_only(self):
        lines = ["| " + LONG, "```", LONG, "```"]
        self.assertEqual(line_width.too_long("a.md", lines, {1, 3}), [])
        self.assertEqual(line_width.too_long("a.mjs", lines, {1, 3}), [1, 3])

    def test_a_single_url_after_the_markers(self):
        url = "https://example.com/" + "x" * 100
        lines = [url, "  # " + url, " * " + url, "// " + url, "- <" + url + ">", "> " + url]
        numbers = set(range(1, len(lines) + 1))
        self.assertEqual(line_width.too_long("a.md", lines, numbers), [])

    def test_a_url_with_text_is_prose(self):
        lines = ["see https://example.com/" + "x" * 100, "https://example.com/" + "x" * 100 + " x"]
        self.assertEqual(line_width.too_long("a.py", lines, {1, 2}), [1, 2])

    def test_a_number_past_the_end_is_skipped(self):
        self.assertEqual(line_width.too_long("a.py", [LONG], {1, 2}), [1])


class ReadLinesTest(unittest.TestCase):
    def read(self, content):
        with tempfile.NamedTemporaryFile("wb", delete=False) as file:
            file.write(content)
        self.addCleanup(os.remove, file.name)
        return line_width.read_lines(file.name)

    def test_the_lines_git_counts(self):
        self.assertEqual(self.read(b"a\r\nb\x0cc\n\nd"), ["a", "b\x0cc", "", "d"])
        self.assertEqual(self.read(b"a\n"), ["a"])
        self.assertEqual(self.read(b""), [])


class MainTest(unittest.TestCase):
    """Runs a real git: the flags of the diff are what is checked here, not the parsing."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = os.path.realpath(tmp.name)
        self.git("init", "-q")
        # A user config that changes the shape of the patch; the action must not depend on it.
        for key, value in (
            ("diff.noprefix", "true"),
            ("color.diff", "always"),
            ("diff.interHunkContext", "3"),
            ("diff.upper.textconv", "tr a-z A-Z"),
        ):
            self.git("config", key, value)
        os.makedirs(os.path.join(self.root, ".git", "info"), exist_ok=True)
        self.write(os.path.join(".git", "info", "attributes"), "*.md diff=upper\n")
        self.write("old.md", LONG + "\n")
        self.write("файл.md", "text\n")
        self.write("moved.md", "text\n" + LONG + "\n")
        self.write("script.sh", "echo\n")
        self.write("code.ts", "x\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "base")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)

    def git(self, *args):
        subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
            + list(args),
            cwd=self.root, check=True, capture_output=True,
        )

    def write(self, path, content):
        with open(os.path.join(self.root, path), "w", encoding="utf-8") as file:
            file.write(content)

    def run_main(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = line_width.main()
        return code, out.getvalue(), err.getvalue()

    def test_nothing_added_is_green(self):
        self.assertEqual(self.run_main(), (0, "", ""))

    def test_committed_uncommitted_and_untracked_lines_count(self):
        self.write("old.md", LONG + "\nshort\n" + LONG + "\n")
        self.write("файл.md", "text\n" + LONG + "\n")
        self.git("commit", "-q", "-am", "edit")
        self.write("script.sh", "echo\n" + LONG + "\n")
        self.write("new.py", "x\n" + "я" * 101 + "\n")
        self.write("code.ts", LONG + "\n")
        self.write("new.txt", LONG + "\n")
        code, out, err = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(
            out, "new.py:2: 101\nold.md:3: 101\nscript.sh:2: 101\nфайл.md:2: 101\n"
        )
        self.assertIn("4 added line(s) past 100 columns", err)

    def test_nearby_hunks_keep_their_numbers(self):
        self.write("near.md", "a\nb\nc\nd\ne\n")
        self.git("add", "near.md")
        self.git("commit", "-q", "-m", "near")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.write("near.md", "A\nb\nc\n" + LONG + "\ne\n")
        code, out, _ = self.run_main()
        self.assertEqual((code, out), (1, "near.md:4: 101\n"))

    def test_a_file_that_is_not_utf8(self):
        with open(os.path.join(self.root, "font.afm"), "wb") as file:
            file.write(b"caf\xe9\n")
        self.git("add", "font.afm")
        self.write("script.sh", "echo\n" + LONG + "\n")
        code, out, _ = self.run_main()
        self.assertEqual((code, out), (1, "script.sh:2: 101\n"))

    def test_a_lone_carriage_return_is_no_line_break(self):
        # Read as a break, `\r-z` would use up a count of the first hunk, and the second one would
        # be taken for its continuation.
        self.write("script.sh", "echo\na\nb\nc\n")
        self.git("commit", "-q", "-am", "base")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.write("script.sh", "echo\nx\r-z\nshort\na\nb\nc\n" + LONG + "\n")
        code, out, _ = self.run_main()
        self.assertEqual((code, out), (1, "script.sh:7: 101\n"))

    def test_a_rename_counts_only_what_it_changed(self):
        self.git("mv", "moved.md", "renamed.md")
        self.write("renamed.md", "text\n" + LONG + "\nmore\n")
        self.git("commit", "-q", "-am", "rename")
        self.assertEqual(self.run_main(), (0, "", ""))

    def test_lines_main_added_after_the_branch_do_not_count(self):
        self.git("checkout", "-q", "-b", "side")
        self.git("checkout", "-q", "-")
        self.write("old.md", LONG + "\n" + LONG + "\n")
        self.git("commit", "-q", "-am", "main moves")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("checkout", "-q", "side")
        self.assertEqual(self.run_main(), (0, "", ""))

    def test_without_origin_main_it_is_an_error(self):
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        code, out, err = self.run_main()
        self.assertEqual((code, out), (2, ""))
        self.assertIn("git fetch origin", err)


if __name__ == "__main__":
    unittest.main()
