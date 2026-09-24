"""Takes the head of a PR into a temporary review tree next to the main worktree.

A review runs its gates in a throwaway worktree of the PR's head (the pr-light-check skill) and
removes it with tree_remove.py whatever the outcome. The steps and their order are not a matter of
taste:

- `.env` is checked first, in the tree the review started in: the gates need it, and without it
  the action stops and says that `make worktree-init` is needed. It does not run that target
  itself: `make worktree-init` takes a slot of the token pool.
- `make db-up` runs from the tree the review started in, never from the temporary one. The project
  name of the database is fixed (`name: telegram-bot-db` in docker-compose.db.yml), and its data
  directory `./tmp/pgsql` leads into the main worktree only through the symlink that
  scripts/worktree-init.sh sets. A temporary tree has no such link, and `make db-up` from it would
  recreate the shared container on an empty `tmp/pgsql`: every tree would silently move to a clean
  database without migrations, and a run on it would be green and notice nothing. The database is
  needed at all because the network of the application is declared external and belongs to it.
- The head comes from `gh pr view --json headRefOid`, not from the branch: the run checks exactly
  the commit the verdict names. A commit already in the repository is not fetched, since the trees
  share their objects and an author's commit made on this machine is there. Otherwise it is fetched
  by its hash with `--no-write-fetch-head`, and a fetch by hash writes no ref: `origin/*` is shared
  by every tree, and a neighbour's fetch holding a ref would refuse this one (the same reason as at
  the first fetch of scripts/worktree-cleanup.sh).
- The path is `<main>-review-<N>` next to the main worktree, `<main>` being the name of its
  directory: tree_remove.py refuses any other. Compose takes the project name of a gate's container
  from the directory name, so every PR gets an image and a volume of its own and the application of
  a task tree is not touched. A tree left at that path by an interrupted earlier run is removed
  first with tree_remove.py; if that fails, the action stops and names the path.
- `git worktree add --detach`: no branch is created or moved, so the PR branch may be checked out in
  the author's tree at the same time.
- `.env` is copied rather than made by `make worktree-init`: that target takes a slot of the token
  pool, while the throwaway containers of the gates need no bot and do not read the token.

On success the action prints the path of the tree and the head, so that the skill can `cd` there
and name the commit in the verdict.
"""

import os
import re
import shutil
import subprocess
import sys
from typing import List, Optional

from tree_remove import NotAReviewTree, Run, main_and_worktrees, reason, remove_tree

PR_NUMBER = re.compile(r"[1-9][0-9]*")


class Stop(Exception):
    pass


def check(done: "subprocess.CompletedProcess[str]", what: str) -> None:
    if done.returncode != 0:
        raise Stop("{} — {}".format(what, reason(done)))


def pr_head(pr: str, run: Run) -> str:
    view = run(
        ["gh", "pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid"],
        capture_output=True,
        text=True,
    )
    check(view, "gh pr view {} failed".format(pr))
    head = view.stdout.strip()
    if not head:
        raise Stop("gh pr view {} named no head".format(pr))
    return head


def ensure_commit(head: str, run: Run) -> None:
    present = run(
        ["git", "cat-file", "-e", head + "^{commit}"], capture_output=True, text=True
    )
    if present.returncode == 0:
        return
    fetch = run(
        ["git", "fetch", "--quiet", "--no-write-fetch-head", "origin", head],
        capture_output=True,
        text=True,
    )
    check(fetch, "could not fetch {} from origin".format(head))


def review_tree_path(pr: str, run: Run) -> str:
    try:
        worktrees = main_and_worktrees(run)
    except NotAReviewTree as failure:
        raise Stop(str(failure))
    if not worktrees:
        raise Stop("git worktree list named no worktree")
    main = worktrees[0]
    return os.path.join(
        os.path.dirname(main), "{}-review-{}".format(os.path.basename(main), pr)
    )


def create_tree(pr: str, run: Run = subprocess.run) -> int:
    here = os.getcwd()
    try:
        if not os.path.isfile(os.path.join(here, ".env")):
            raise Stop("no .env in {} — run make worktree-init there".format(here))
        check(
            run(["make", "db-up"], cwd=here, capture_output=True, text=True),
            "make db-up failed",
        )
        head = pr_head(pr, run)
        ensure_commit(head, run)
        tree = review_tree_path(pr, run)
        if os.path.lexists(tree) and remove_tree(tree, run) != 0:
            raise Stop("a tree of an earlier run is left at {}".format(tree))
        check(
            run(
                ["git", "worktree", "add", "--detach", tree, head],
                capture_output=True,
                text=True,
            ),
            "git worktree add {} failed".format(tree),
        )
    except Stop as stop:
        print("Stopped: {}".format(stop))
        return 1

    try:
        shutil.copyfile(os.path.join(here, ".env"), os.path.join(tree, ".env"))
    except OSError as failure:
        print(
            "Stopped: .env was not copied — {}; the tree is left, remove it: "
            "make review-tree-remove path={}".format(failure, tree)
        )
        return 1

    print("Tree: {}".format(tree))
    print("Head: {}".format(head))
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or not PR_NUMBER.fullmatch(args[0]):
        print("usage: make review-tree-create pr=<N>", file=sys.stderr)
        return 2
    return create_tree(args[0])


if __name__ == "__main__":
    sys.exit(main())
