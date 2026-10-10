# pr-light-check: the fallbacks

`SKILL.md` sends you here from its step 2, when the report of `make review-run` leaves a check to
you. The steps are numbered as in `SKILL.md`.

## Step 2. The checks the run leaves to you

The target does not run `make-targets`, `scripts` and the comparison of a red gate with the base
yet. The two gates get a `Not run` line; the comparison has no line of its own, and the `Red`
section of the report sends you here. The two gates need a tree of the PR head, the comparison a
tree of `origin/main` ("Red" below). Create the tree of the PR head from the tree you were started
in:

```bash
make review-tree-create pr=<N>
cd <the path from its Tree: line>
```

The target prints `Tree: <path>` and `Head: <sha>`. What it runs and why is in the docstring of
`scripts/review/tree_create.py`.

- `Stopped: <reason>` — give the checks of this step `n-a` with that reason.
- The stop `.env was not copied` names a tree this run did create: the cleanup removes it like any
  other.
- The path is `<main>-review-<N>` next to the main worktree, where `<main>` is the name of its
  directory. The cleanup refuses a tree named or placed otherwise: why is in the docstring of
  `scripts/review/tree_remove.py`.

The commands below run from the temporary tree, so the `cd` is required: `allowed-tools` lists the
targets by exact match (`Bash(make coverage)`), and `make -C <path> coverage` does not fall under
them. `make db-up` is never called from a temporary tree: there it recreates the shared database on
an empty `tmp/pgsql` (the docstring above says how).

This is the allowlist of the step. Also allowed are `make token-status` and `scripts/bot-token.sh`
with no arguments, since neither changes anything. Nothing else.

### make-targets

```bash
make help
make help | grep -w '<changed target>'
make -n <changed target>
```

`make -n` prints the recipe without running it. That checks how the variables expand (`DC_APP_RUN`,
`FILES`, `RENEW_TOKEN`) with no side effects. The one exception in GNU make is a line with
`$(MAKE)`: make runs it even under `-n`, but passes `-n` on through `MAKEFLAGS`, so the nested make
only prints too.

Look in the output whether the variable values were substituted, whether an argument is left empty,
and whether a multi-line `files` got glued into one command.

For a new or renamed target also check, without commands:

- it has a `## description` comment, otherwise it does not get into `make help`;
- it is in `.PHONY`;
- the recipe itself rejects a missing required parameter (the example is `migrate-create`).

### scripts

```bash
sh -n scripts/<file>.sh
docker run --rm -v "$PWD":/app -w /app node:24-bookworm-slim sh -n scripts/<file>.sh
```

The second run is needed when the body of the script changed, not only its comments. The scripts
are declared `#!/usr/bin/env sh`, but on macOS `/bin/sh` is bash in POSIX mode, and it lets through
bashisms that fail on dash in Linux. The image is only a source of dash; the Node version has
nothing to do with it.

### Red

Red in `make -n`, `sh -n` and `make mutation-full-check` is unambiguous by itself. What the red of
`make mutation-full-check` means is in step 1 of `SKILL.md`.

Red in `build`, `typecheck`, `test`, `test-fonts`, `lint`, `format-check` or `python`, and you
doubt this PR brought it — compare with the base:

1. Create a worktree on `origin/main` at `<main>-review-<N>-base` next to the main worktree.
2. Copy `.env` into it and move into it.
3. Run **only the failed** command.

That is a temporary tree too, and it is removed the same way.

## Cleaning up the temporary trees

`make review-run` removes its tree itself; read its `Not cleaned up:` and `Refused:` lines as below.

Remove every temporary tree you created in step 2 right after step 3, in both modes: the PR tree
and the `origin/main` tree from "Red". Steps 4–6 do not need them, and a failed cleanup before
step 5 still makes it into the verdict. The run broke off earlier — the cleanup goes before the
stop. For each tree:

```bash
cd <the tree you were started in>
make review-tree-remove path=<temporary path>
```

The target is called from the tree you were started in, by the hard rules. It takes the tree's
application down together with its image and volume and removes the tree. What it runs, in which
order and why is in the docstring of `scripts/review/tree_remove.py`.

- `Not cleaned up: <path> — <reason>` — put the line into the report as it is, so that a human
  removes the tree. Either the application failed to go down and the tree is kept on purpose, or
  the tree was not removed.
- `Refused:` — the path is not a temporary review tree (step 2); nothing was removed.

The price: the next review round of the same PR builds the image anew. The throwaway container
builds it only when there is no image (the comment on the `rebuild` target in the `Makefile`), and
after the cleanup there is none. That is minutes of build per round against an image left on disk
by every round.
