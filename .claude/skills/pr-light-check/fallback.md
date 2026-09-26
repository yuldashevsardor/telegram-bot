# pr-light-check: the fallbacks

`SKILL.md` sends you here from its step 2, when the report of `make review-run` leaves a check to
you. The steps are numbered as in `SKILL.md`.

## Step 2. The checks the run leaves to you

The target does not run `make-targets`, `scripts`, your own mutation run and the comparison of a red
gate with the base yet: its `Not run` lines name them. Each needs a tree of the PR head. Create it
from the tree you were started in:

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
  directory. The cleanup refuses a tree named or placed otherwise, so that a wrong argument cannot
  remove the main worktree or a task worktree.

The commands below run from the temporary tree, so the `cd` is required: `allowed-tools` lists the
targets by exact match (`Bash(make coverage)`), and `make -C <path> coverage` does not fall under
them. `make db-up` is never called from a temporary tree: there it recreates the shared database on
an empty `tmp/pgsql` (the docstring above says how).

This is the allowlist of the step. Also allowed are `make token-status` and `scripts/bot-token.sh`
with no arguments, since neither changes anything. So is the probe file of the `mutation`
substitution (below, "make-targets"): it is untracked and removed right after the check, so the PR
tree stays the one that was sent. Nothing else.

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

The recipe of the `mutation` target is checked beyond the expansion. It counts `MUTATION_DIRTY`,
the `clean=` field of the run record, and condition 2 of the record's acceptance rests on that field
(`scripts/review/mutation_record.py`). A broken count hides from both gates:

- `make -n` prints the chain `tree=…&&dirty=…||dirty=unknown` but does not run it;
- a run under `mutation-full` goes on a clean tree, where `clean=yes` is expected anyway.

So a recipe in which a failing `git` or a non-empty `git status` gives 0 looks sound, and records
start arriving with `clean=yes` on an unchecked tree. Review would then accept a run that did not go
on the PR's commit.

The diff touches the `mutation` recipe — run the substitution. `DC_APP_RUN` is a simple assignment
in the `Makefile`, and overriding it from the command line replaces the container launch with
`echo`. The real recipe runs and prints the counted values in a second.

```bash
# clean tree — MUTATION_DIRTY=0
make mutation DC_APP_RUN=echo | grep '^env MUTATION_HEAD='
# one untracked file — one more
touch mutation-dirty-probe
make mutation DC_APP_RUN=echo | grep '^env MUTATION_HEAD='
rm mutation-dirty-probe
# git does not answer — MUTATION_DIRTY=unknown, not a number
make mutation DC_APP_RUN=echo GIT_DIR=/nonexistent | grep '^env MUTATION_HEAD='
```

On a fresh checkout the first probe gives 0, the second exactly one more, the third `unknown`. A
mismatch — the gate is `fail`: the substitution counts something other than what goes into the
record. In the last probe `MUTATION_HEAD` goes empty together with `dirty`, and that is expected: on
an empty head the wrapper sets `clean=unknown` itself (`docs/architecture/testing.md`, "The run
record").

The form of the commands is thought through; do not swap it for a more familiar one:

- `grep` takes the executed line. make also prints the recipe itself, and in its text
  `MUTATION_DIRTY="$dirty"` is not expanded yet.
- `GIT_DIR` is passed as a make variable rather than a shell prefix. make puts command-line
  variables into the recipe's environment, and in this form the command starts with
  `make mutation`, so the skill's `allowed-tools` covers it like the other probes.
- The probe file is untracked and removed by the next line, so the PR diff does not change.
- The target creates the `reports` directory even without a run, and it is in `.gitignore`.

### scripts

```bash
sh -n scripts/<file>.sh
docker run --rm -v "$PWD":/app -w /app node:24-bookworm-slim sh -n scripts/<file>.sh
```

The second run is needed when the body of the script changed, not only its comments. The scripts
are declared `#!/usr/bin/env sh`, but on macOS `/bin/sh` is bash in POSIX mode, and it lets through
bashisms that fail on dash in Linux. The image is only a source of dash; the Node version has
nothing to do with it.

### Your own mutation run

The run is yours in two cases:

- the `Not run` line of a mutation gate ends in `the own run by fallback.md`: the record was refused
  or not checked;
- a record accepted on condition 1, and the table turns on one of its three gates.

Run the target in the PR tree: `make mutation files="<the Area: line>"` under `mutation`,
`make mutation` under `mutation-full`. Which threshold it checks and why a run without mutants is
green is in `docs/architecture/testing.md`, "Threshold".

- The outcome of the gate is the target's exit code. The score comes from the
  `Final mutation score` line.
- `clear-text` prints the survived (`Survived`) and uncovered (`NoCoverage`) mutants above that
  line, one by one: the mutator, `<file>:<line>:<column>` and the replacement. List them in "Red".
- The score `NaN` is `n-a`, as in step 1.
- In the `mutation:` line of the verdict say `own run` and why the record was not accepted: the
  reason of the `Not run` line.

The exit code can be non-zero without survivors: the run broke off on a crash of the checker
process, and there is no `Final mutation score` line. What stands behind these messages is in
`docs/architecture/testing.md`, "The type checker". What to do on each:

- `Checker process […] crashed with exit code null` — repeat the target once;
- `Checker process […] ran out of memory` — the gate is `fail`: the checker lacks the heap limit
  from `checkerNodeArgs` on the tree of this PR;
- the run broke off with a `Child process [pid …]` error and there are no `Checker process` lines —
  the checker crashed on the initial compilation, which has no retry. Repeat the target once, as in
  the first line.

The repeat broke off too — the gate is `n-a` with the reason "the run broke off on a checker
crash", and the verdict is BLOCKED: there is nothing to judge the mutants by.

`Child process [pid …]` lines alone say nothing: they are written about the runner too, and a runner
crash on a mutant does not break the run off.

- The run reached `Final mutation score` — read the gate by the score, however many such lines stand
  above it.
- It broke off with `Something went wrong in the initial test run` — the initial test run failed,
  not the checker. Read the gate as usual, by the exit code.

`mutation-full` mutates the whole of `src/`. That takes minutes, longer than the limit of a single
command, so run it in the background and read the result on completion. While it runs, start no
other gates. The load would come from the review itself, and under load a mutant's status lies both
ways (`docs/architecture/testing.md`, "Timeouts and errors").

Publish the record of your own run in the PR as soon as it finishes. A repeat from "Red" overwrites
`reports/mutation/record.md`, and the cleanup deletes the temporary tree together with it.

1. Copy the record into a temporary file outside the repository.
2. Append an empty line and the signature from `CLAUDE.md` ("Agent signature on GitHub").
3. Publish: `gh pr comment <N> --body-file <file>`.

The records of repeats are not published: the gate's record stays the last in the PR. The
`--no-post` flag cancels this publication too. It comes in the arguments, and from
`pr-deep-review` together with the gates.

### Red

Red in `make -n` and `sh -n` is unambiguous by itself.

Red in `mutation` and `mutation-full`, of your own run or of an accepted record — repeat on every
file with survivors: `make mutation files="<file>"`. The threshold of 100 has no margin, and on a
loaded machine a mutant's status lies both ways (`docs/architecture/testing.md`, "Timeouts and
errors"). The whole area needs no repeat: the mutants of other files do not affect the status of
these.

A repeat refines the red but does not turn it green: the gate is `fail` whatever the outcome.

- The survivor stands in the `clear-text` output again, with the same mutator, place and `+` line
  — the red is confirmed.
- It does not — add to it in "Red" the note "possible drift: recheck on an idle machine".

The status of the repeat does not prove drift: under load a survivor hides both under `Timeout`
and under `Killed` with the ordinary message of a spec, and review has no idle machine.

Red in `build`, `typecheck`, `test`, `lint`, `format-check`, `python` or the mutation gates, and you
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
