"""Lists the lines a change added past 100 columns in prose and host scripts.

The width of `*.md`, `*.py`, `*.mjs` and `*.sh` was written nowhere, and review inferred it from
the neighbouring lines: a nit of the form "line N is 117 characters, the rest wraps at 100" on
most PRs, sometimes a whole round spent on rewrapping one line. The number lives here and nowhere
else. `.ts` is not checked: Prettier owns the width of its code (`printWidth` in .prettierrc.js).

`make check` runs the action on the host before the container: `.git` is not mounted into the
container. Only added lines count, so a line already too long in `main` does not fail the check.
They are the lines added since the merge-base of `origin/main` and `HEAD`, up to the working
tree, so an edit not yet committed is checked too, and every line of an untracked file counts. A
renamed file keeps its lines: only what the rename changed counts.

A column is a character, not a byte: a Cyrillic line is as wide as a Latin one of the same length.
What cannot be wrapped is exempt:

- in Markdown, a table row (the line starts with `|`), the lines of a fenced code block with its
  fences (a closing fence has the character of the opening one and is at least as long; a block
  left open runs to the end of the file) and the YAML frontmatter (the file starts with `---` and
  it runs to the next `---`);
- in any of the files, a line that is a single URL, after the indentation and the markers of a
  comment, a list or a quote.

The offending lines go to stdout as `path:line: width`, and the exit code is 1. A failed `git` is
an error with the exit code 2, never an empty list: an empty list reads as "every line fits".
"""

import codecs
import os
import re
import subprocess
import sys
from typing import Dict, List, Optional, Set

LIMIT = 100
EXTENSIONS = (".md", ".py", ".mjs", ".sh")

HUNK = re.compile(r"^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
URL = re.compile(r"^[\s#/*>+-]*<?https?://\S+$")


class GitError(Exception):
    pass


def git(args: List[str], root: str = ".") -> str:
    done = subprocess.run(["git"] + args, cwd=root, capture_output=True, text=True)
    if done.returncode != 0:
        raise GitError(f"git {' '.join(args)}: {done.stderr.strip()}")
    return done.stdout


def unquote(path: str) -> str:
    """A path git quoted C-style (a non-ASCII character, a quote in it) back to the name."""
    if not path.startswith('"'):
        return path
    return codecs.escape_decode(path[1:-1].encode("utf-8"))[0].decode("utf-8")


def added_lines(patch: str) -> Dict[str, Set[int]]:
    """The numbers of the added lines by path, from a `-U0` patch with the `b/` prefix.

    A hunk is read by the counts of its header, not by the first character alone: an added line
    `++ x` reads as `+++ x` in the patch, the same as the header of the next file.
    """
    added: Dict[str, Set[int]] = {}
    path = None
    line = old = new = 0
    # Not splitlines(): it also breaks a line on \x0c or \u2028, and the counts would drift.
    for text in patch.split("\n"):
        if old or new:
            if text.startswith("+"):
                if path is not None:
                    added.setdefault(path, set()).add(line)
                line += 1
                new -= 1
            elif text.startswith("-"):
                old -= 1
            continue
        if text.startswith("+++ "):
            # git ends the header with a tab when the name has a space in it.
            name = unquote(text[4:].rstrip("\t"))
            path = name[2:] if name.startswith("b/") else None
            continue
        match = HUNK.match(text)
        if match:
            old = int(match.group(1) or 1)
            line = int(match.group(2))
            new = int(match.group(3) or 1)
    return added


def exempt_markdown(lines: List[str]) -> Set[int]:
    """The numbers (from 1) of the Markdown lines that cannot be wrapped."""
    exempt: Set[int] = set()
    fence = None
    frontmatter = bool(lines) and lines[0].rstrip() == "---"
    for number, text in enumerate(lines, 1):
        if frontmatter:
            exempt.add(number)
            if number > 1 and text.rstrip() == "---":
                frontmatter = False
            continue
        match = FENCE.match(text)
        if fence is not None:
            exempt.add(number)
            closing = match and match.group(1)[0] == fence[0] and not match.group(2).strip()
            if closing and len(match.group(1)) >= len(fence):
                fence = None
            continue
        if match and not (match.group(1)[0] == "`" and "`" in match.group(2)):
            fence = match.group(1)
            exempt.add(number)
            continue
        if text.lstrip().startswith("|"):
            exempt.add(number)
    return exempt


def too_long(path: str, lines: List[str], numbers: Set[int]) -> List[int]:
    """Those of `numbers` that are past the limit and not exempt, in order."""
    exempt = exempt_markdown(lines) if path.endswith(".md") else set()
    found = []
    for number in sorted(numbers):
        if number > len(lines) or number in exempt:
            continue
        text = lines[number - 1]
        if len(text) > LIMIT and not URL.match(text):
            found.append(number)
    return found


def read_lines(path: str) -> List[str]:
    """The lines as git numbers them: split by `\\n` alone, with no line after the last one."""
    with open(path, encoding="utf-8", errors="replace", newline="") as file:
        lines = file.read().split("\n")
    if lines[-1] == "":
        lines.pop()
    return [text[:-1] if text.endswith("\r") else text for text in lines]


def main() -> int:
    try:
        root = git(["rev-parse", "--show-toplevel"]).strip()
        try:
            git(["rev-parse", "--verify", "--quiet", "origin/main"], root)
        except GitError:
            raise GitError("origin/main is not there: git fetch origin") from None
        base = git(["merge-base", "origin/main", "HEAD"], root).strip()
        patch = git(
            ["diff", "-U0", "--no-color", "--no-ext-diff", "--find-renames", "--diff-filter=d",
             "--src-prefix=a/", "--dst-prefix=b/", base, "--"],
            root,
        )
        untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], root)
    except GitError as error:
        print(f"line_width: {error}", file=sys.stderr)
        return 2
    added: Dict[str, Optional[Set[int]]] = dict(added_lines(patch))
    for path in filter(None, untracked.split("\0")):
        added[path] = None
    found = 0
    for path in sorted(added):
        full = os.path.join(root, path)
        if not path.endswith(EXTENSIONS) or not os.path.isfile(full):
            continue
        lines = read_lines(full)
        numbers = added[path]
        if numbers is None:
            numbers = set(range(1, len(lines) + 1))
        for number in too_long(path, lines, numbers):
            print(f"{path}:{number}: {len(lines[number - 1])}")
            found += 1
    if found:
        # stdout is block-buffered in a pipe, and the summary would come before the lines.
        sys.stdout.flush()
        print(
            f"line_width: {found} added line(s) past {LIMIT} columns; wrap them "
            "(what is exempt is in the docstring of scripts/review/line_width.py)",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
