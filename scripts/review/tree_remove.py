"""Removes a temporary review tree together with the image and the volume of its application.

A review runs its gates in a throwaway worktree next to the main one and removes it by this
action, whatever the outcome of the run (the pr-light-check skill). The order and the flags
are not a matter of taste:

- `down` goes before the removal. docker-compose.app.yml has no `name`, so Compose takes the
  project name from the directory: once the directory is gone, the `<directory>-app` image
  (about a gigabyte) and the `<directory>_app-tmp` volume can no longer be named, and they are
  orphaned.
- `--remove-orphans` takes the container of a gate that a killed run left running. Without the
  flag `down` skips that container, leaves the image and the volume "in use" and still exits
  with 0 (checked in PR #551).
- A failed `down` keeps the tree: without the directory this command can no longer remove the
  image, and the tree is left for a human, named in the "Not cleaned up" line.
- `git worktree remove` runs from the main worktree, not from the tree being removed.
- `make worktree-cleanup` does not fit: it requires the branch to be merged into `main` on
  origin and deletes it there, while the PR under review is alive.
- `down` does not touch the shared database: it is a separate Compose project,
  `telegram-bot-db` (docker-compose.db.yml).

The path is checked before anything runs, so that a wrong argument cannot take down the
application of the main worktree or of a task worktree and remove it: a review tree is a
worktree of this repository named `telegram-bot-review-*` right next to the main one. A task
worktree lies there too, and nothing forbids naming a task `review-…`, so the name alone does
not tell them apart; the `tmp/pgsql` symlink does: `scripts/worktree-init.sh` sets it in every
task worktree, while a review tree gets only a copied `.env` and must never have it.
"""

import os
import re
import subprocess
import sys
from typing import Callable, List, Optional, Tuple

PREFIX = "telegram-bot-review-"
DOWN = [
    "docker",
    "compose",
    "-f",
    "docker-compose.app.yml",
    "down",
    "--rmi",
    "local",
    "--volumes",
    "--remove-orphans",
]

Run = Callable[..., "subprocess.CompletedProcess[str]"]

# Compose writes its progress to stderr too ("Container … Stopping"), and it may stand above the
# error, so the first line of the output is not the reason.
MEANINGFUL = re.compile(r"\b(error|fatal|cannot|denied|failed)\b", re.IGNORECASE)


class NotAReviewTree(Exception):
    pass


def main_and_worktrees(run: Run) -> List[str]:
    """The paths of the repository's worktrees, the main one first, as `git worktree list` gives them."""
    listed = run(
        ["git", "worktree", "list", "--porcelain"], capture_output=True, text=True
    )
    if listed.returncode != 0:
        raise NotAReviewTree("git worktree list failed: " + reason(listed))
    prefix = "worktree "
    return [
        os.path.realpath(line[len(prefix) :])
        for line in listed.stdout.splitlines()
        if line.startswith(prefix)
    ]


def check_review_tree(path: str, run: Run) -> Tuple[str, str]:
    """The real paths of the tree and of the main worktree, or NotAReviewTree with the reason."""
    tree = os.path.realpath(path)
    worktrees = main_and_worktrees(run)
    if not worktrees:
        raise NotAReviewTree("git worktree list named no worktree")
    main = worktrees[0]
    if tree == main:
        raise NotAReviewTree("it is the main worktree")
    if tree not in worktrees[1:]:
        raise NotAReviewTree("it is not a worktree of this repository")
    if os.path.dirname(tree) != os.path.dirname(main):
        raise NotAReviewTree("it does not lie next to the main worktree " + main)
    if not os.path.basename(tree).startswith(PREFIX):
        raise NotAReviewTree("its name does not start with " + PREFIX)
    if os.path.islink(os.path.join(tree, "tmp", "pgsql")):
        raise NotAReviewTree(
            "it has the tmp/pgsql symlink of make worktree-init, so it is a task worktree"
        )
    return tree, main


def reason(done: "subprocess.CompletedProcess[str]") -> str:
    lines = [
        line.strip()
        for line in (done.stderr or "").splitlines() + (done.stdout or "").splitlines()
        if line.strip()
    ]
    for line in lines:
        if MEANINGFUL.search(line):
            return line
    if lines:
        return lines[-1]
    return "exit code {}".format(done.returncode)


def remove_tree(path: str, run: Run = subprocess.run) -> int:
    try:
        tree, main_tree = check_review_tree(path, run)
    except NotAReviewTree as refusal:
        print("Refused: {} is not a temporary review tree — {}".format(path, refusal))
        return 2

    down = run(DOWN, cwd=tree, capture_output=True, text=True)
    if down.returncode != 0:
        print("Not cleaned up: {} — {}".format(tree, reason(down)))
        return 1

    remove = run(
        ["git", "worktree", "remove", "--force", tree],
        cwd=main_tree,
        capture_output=True,
        text=True,
    )
    if remove.returncode != 0:
        print("Not cleaned up: {} — {}".format(tree, reason(remove)))
        return 1

    print("Cleaned up: {}".format(tree))
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or not args[0]:
        print("usage: make review-tree-remove path=<tree>", file=sys.stderr)
        return 2
    return remove_tree(args[0])


if __name__ == "__main__":
    sys.exit(main())
