---
name: pr-light-check
description: Light Pull Request review — a mechanical run of the repository checks by the gates passed in, documentation drift in the changed lines and issue compliance, with a verdict and a PR comment. Run by the /review-pr command, and by the pr-deep-review skill as its mechanical part. Not for ordinary work on code and not for checking uncommitted edits.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(make rebuild), Bash(make build), Bash(make typecheck), Bash(make coverage), Bash(make lint), Bash(make format-check), Bash(make mutation:*), Bash(make mutation-area:*), Bash(make mutation-record:*), Bash(make help), Bash(make token-status), Bash(make -n:*), Bash(sh -n:*), Bash(docker run:*), Bash(make review-test), Bash(make review-tree-create:*), Bash(make review-tree-remove:*), Bash(scripts/bot-token.sh), Bash(cd:*), Bash(ls:*), Bash(cp:*), Bash(touch mutation-dirty-probe), Bash(rm mutation-dirty-probe), Bash(grep:*), Bash(awk:*), Read, Grep, Glob, Write
---

You run the repository checks over the code of a Pull Request and decide whether it can be
merged.

Input: the PR number, the list of gates, the flags. The gates are computed by the `/review-pr`
command — you do not sort the diff into groups yourself.

This is the light review. Architecture invariants, bug hunting, smells and overlaps with other
branches are not your job, they belong to `pr-deep-review`. Your verdict rests on three things:
the run, documentation drift and issue compliance.

## Two modes

- **Standalone** (called by the `/review-pr` command) — you do everything: steps 1–6.
- **Mechanical** (called by `pr-deep-review`) — you do only steps 1–3 and the cleanup and return
  the run results and the documentation findings as lines. No issue, no verdict, no comment:
  those belong to the caller. The exception is the record of your own mutation run ("The
  author's run record"): it is not a verdict but a fact of the run, and you publish it.

Step 3 is part of the mechanical mode because the check has one owner. `pr-deep-review` sees the
`*.md` diff only through you, and a documentation-only PR never reaches it at all; with the check
split in two, the repository would hold two copies of the checklist, and the first edit would set
them apart.

## Hard rules of the role

- **You fix nothing.** The result is a report and a verdict. Something red — say so and suggest
  fixing it separately; do not edit files and do not run `--fix` along the way. `cp` and `Write`
  are granted for the records the steps below prescribe and only for them: creating a file is an
  edit too.
- **Run, do not eyeball.** A check you did not run is `n-a`, not `ok`. "Looks correct", "the
  syntax is fine", "should work" without the output of a command are forbidden. The one exception
  is an accepted mutation run record of the author ("The author's run record"): it is written by
  `make mutation` itself, not retold by the author.
- **Allowlist.** You may really run only what is listed in step 2 and in "Cleaning up the
  temporary trees". Everything else — including any `Makefile` target not listed there — is never
  run, even if a gate points at it; such a check goes into the report as a "Not run" line with the
  reason. The list is an allowlist rather than a denylist on purpose: a new `Makefile` target counts
  as dangerous until it is written in here.
- **What was not run is not hushed up.** Every check a gate turned on and you did not perform goes
  into the report with the reason.
- **The review's tools come from the tree you were started in, the gates run the PR's code.** A
  target that runs an action of `scripts/review/` is called from the tree you were started in, never
  from a temporary one: there the `Makefile` and `scripts/review/` are the PR's code under review.
  Called from there, a PR would be reviewed by its own version of the action, and a PR opened
  before an action was merged has no such target at all (a re-review of PR #524 got `No rule to
  make target 'mutation-area'`). What an action reads of the PR it takes from the PR tree named in
  its arguments or from the objects the trees share. `make review-test` is not such a target: it is
  the `python` gate over the PR's specs.
- **A temporary tree does not outlive the run.** Every one you created is removed by "Cleaning up
  the temporary trees" whatever the outcome: a red gate, BLOCKED and a stop halfway included.

## Step 1. Preparation

A run gate is any of those in the table of step 2. None of them — skip step 2 whole: no checkout,
no database, no containers. Building a project in which not a single line of executable code
changed costs minutes and cannot yield a single finding. Step 3 needs no checkout either: it reads
the diff through `gh`.

At least one run gate — take the head of the PR into a temporary tree, calling the target from the
tree you were started in:

```bash
make review-tree-create pr=<N>
cd <the path from its Tree: line>
```

The target checks `.env` here, brings up the shared database from here (it wipes nothing), takes the
head from `gh`, removes a tree an interrupted earlier run left at the same path and creates a
detached tree with a copy of `.env`. It prints `Tree: <path>` and `Head: <sha>`; what it runs, in
which order and why is in the docstring of `scripts/review/tree_create.py`. The path is
`<main>-review-<N>` next to the main worktree, where `<main>` is the name of its directory
(`telegram-bot-review-556`): the cleanup refuses a tree named or placed otherwise, so that a wrong
argument cannot remove the main worktree or a task worktree.

`Stopped: <reason>` in its output — stop the run and give the checks of step 2 `n-a` with that
reason; step 3 is still done, `gh` is enough for it. `no .env` among the reasons means that
`make worktree-init` is needed here: say so and do not run it yourself, it takes a slot of the token
pool. A `Not cleaned up:` line above the stop — an earlier run's tree could not be removed — goes
into the report as "Cleaning up the temporary trees" says. The stop `.env was not copied` names a
tree this run did create: remove it there like any other.

The gates of step 2 run from the temporary tree, so the `cd` is required: the targets are listed in
`allowed-tools` by exact match (`Bash(make coverage)`), and `make -C <path> coverage` does not fall
under them. The review actions among them are the exception of the hard rules: for them `cd` back
to the tree you were started in, then into the PR tree again. `make db-up` is never called from a temporary tree, neither here nor in "Red": there it
recreates the shared database on an empty `tmp/pgsql` (the docstring above says how).

## Step 2. The run by gates

Run only what the gates turned on. The order matters: `rebuild` goes first.

| Gate | Command |
| --- | --- |
| `rebuild` | `make rebuild` |
| `build` | `make build` |
| `typecheck` | `make typecheck` |
| `test` | `make coverage` |
| `lint` | `make lint` |
| `format-check` | `make format-check` |
| `make-targets` | `make help`, then `make -n <changed target>`; the `mutation` recipe touched — also the substitution (below) |
| `scripts` | `sh -n <script>`, then a parse by dash |
| `python` | `make review-test` |
| `mutation` | `make mutation-area pr=<N> tree=<the PR tree>` and `make mutation-record …` from the tree you were started in, then `make mutation files="<its output>"` |
| `mutation-full` | `make mutation-record …` from the tree you were started in, then `make mutation` |

This is the allowlist. Also allowed are `make token-status` and `scripts/bot-token.sh` with no
arguments — neither changes anything — and the probe file of the `mutation` substitution (below,
"make-targets"): it is untracked and removed right after the check, so the PR tree stays the one
that was sent. Nothing else.

### What is not on the list and why

The `Makefile` can do more than the list. These targets look fitting in a review but are left out
on purpose:

- `lint-fix`, `format` — they edit files in the PR tree. That breaks "you fix nothing" outright:
  after them you check not the code that was sent, and the red of `lint` and `format-check`
  disappears together with the finding.
- `test-watch` — it does not finish but waits for changes. Run it and the run hangs.
- `test` — the same specs as `coverage` but without the coverage threshold
  (`docs/architecture/testing.md`, "Coverage"): a PR that dropped coverage below the threshold
  would pass it green, while `make check` fails for the author. So the `test` gate runs
  `make coverage` and loses nothing by it: `nyc` runs the same `mocha`, a failed spec is printed the
  same way (`N failing` and its error), and the run fails even at 100% coverage. `make coverage`
  writes its report into `./coverage` of the PR tree — the directory is in `.gitignore`, the diff
  does not change.
- `check` — `typecheck`, `lint`, `format:check` and `test:coverage` in a row in one output. The
  report needs a line per gate, so the targets run one by one.

### rebuild

The throwaway container takes the ready image and rebuilds it itself only when there is no image at
all. The reasons and what lives in the image are in the comment on the `rebuild` target in the
`Makefile`. Without a rebuild you check new code against old dependencies and an old config and get
a green result that means nothing.

The `build`, `typecheck`, `coverage`, `lint` and `format-check` targets run npm scripts from
`package.json`, and that lives in the image. So a PR that adds or renames a script fails with
`Missing script` on an image that was not rebuilt. That is not a review finding but a missed
`rebuild` — rebuild and repeat.

### build and typecheck

Both run `tsc`, but by different tsconfigs, and neither replaces the other: the file set of
`typecheck` is wider. What is added to it and why is in the comment in `tsconfig.check.json`. A
green `build` on a PR that touches specs or migrations says nothing about their types.

### lint and format-check

They run over the whole repository, without `files=`. The repository is green as a whole, so
anything red here was brought by this PR — there is no point narrowing the file list.

### make-targets

```bash
make help
make help | grep -w '<changed target>'
make -n <changed target>
```

`make -n` prints the recipe without running it — that is the check of how the variables expand
(`DC_APP_RUN`, `FILES`, `RENEW_TOKEN`) with no side effects. The one exception in GNU make is lines
with `$(MAKE)`: those it runs even under `-n`, but it passes `-n` on through `MAKEFLAGS`, so the
nested make only prints too.

Look in the output: whether the variable values were substituted, whether an argument is left
empty, whether a multi-line `files` got glued into one command.

For a new or renamed target also check, without commands: whether it has a `## description`
comment (otherwise it does not get into `make help`), whether it is in `.PHONY`, whether the recipe
itself rejects a missing required parameter (the example is `migrate-create`).

The recipe of the `mutation` target is checked beyond the expansion. It counts `MUTATION_DIRTY` —
the `clean=` field of the run record, on which condition 2 of its acceptance rests
(`scripts/review/mutation_record.py`). `make -n` prints the chain
`tree=…&&dirty=…||dirty=unknown` but does not run it, and a run under `mutation-full` goes on a
clean tree, where `clean=yes` is expected anyway. So a recipe in which a failing `git` or a
non-empty `git status` gives 0 looks sound under both gates, and records start arriving with
`clean=yes` on an unchecked tree — review would accept a run that did not go on the PR's commit.
The `mutation` recipe touched in the diff — run the substitution. `DC_APP_RUN` is a simple
assignment in the `Makefile`, and overriding it from the command line replaces the container
launch with `echo`: the real recipe runs and prints the counted values in a second.

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

The expected values are in the comments: on a fresh checkout the first probe gives 0, the second
exactly one more, the third `unknown`. A mismatch — the gate is `fail`: the substitution counts
something other than what goes into the record. `MUTATION_HEAD` goes empty in the last probe
together with `dirty`, and that is expected — on an empty head the wrapper sets `clean=unknown`
itself (`docs/architecture/testing.md`, "The run record").

The form of the commands is thought through; do not swap it for a more familiar one. `grep` takes
the executed line: make also prints the recipe itself, and in its text `MUTATION_DIRTY="$dirty"`
is not expanded yet. `GIT_DIR` is passed as a make variable rather than a shell prefix: make puts
command-line variables into the recipe's environment, and in this form the command starts with
`make mutation` — so it is covered by the skill's `allowed-tools`, like the other probes. The probe
file is untracked and removed by the next line, the PR diff does not change; the `reports`
directory the target creates even without a run, and it is in `.gitignore`.

### scripts

```bash
sh -n scripts/<file>.sh
docker run --rm -v "$PWD":/app -w /app node:24-bookworm-slim sh -n scripts/<file>.sh
```

The second run is needed when the body of the script changed, not only its comments: the scripts
are declared `#!/usr/bin/env sh`, but on macOS `/bin/sh` is bash in POSIX mode, and it lets through
bashisms that fail on dash in Linux. The image here is only a source of dash; the Node version has
nothing to do with it.

### mutation and mutation-full

Which threshold `make mutation` checks and why a run without mutants is green — in
`docs/architecture/testing.md`, "Threshold". Before running the target, check the author's run
record (below, "The author's run record"): an accepted one replaces your run. The rest is reading
the output. The outcome of the gate is the target's exit code, the score comes from the
`Final mutation score` line. Survived (`Survived`) and uncovered (`NoCoverage`) mutants `clear-text`
prints above it, one by one: the mutator, `<file>:<line>:<column>` and the replacement. List them in
"Red".

The exit code can be non-zero without survivors: the run broke off on a crash of the checker
process, and there is no `Final mutation score` line. What stands behind these messages is in
`docs/architecture/testing.md`, "The type checker"; here is what to do on each:

- `Checker process […] crashed with exit code null` — repeat the target once;
- `Checker process […] ran out of memory` — the gate is `fail`: the checker lacks the heap limit
  from `checkerNodeArgs` on the tree of this PR;
- the run broke off with a `Child process [pid …]` error and there are no `Checker process` lines —
  the checker crashed on the initial compilation, which has no retry: repeat the target once, as in
  the first line.

The repeat broke off too — the gate is `n-a` with the reason "the run broke off on a checker
crash", the verdict is BLOCKED: there is nothing to judge the mutants by.

`Child process [pid …]` lines alone say nothing: they are written about the runner too, and its
crash on a mutant does not break the run off. The run reached `Final mutation score` — read the gate
by the score, however many such lines stand above. It broke off with
`Something went wrong in the initial test run` — the initial test run failed, not the checker, and
the gate is read as usual, by the exit code.

`mutation-full` mutates the whole of `src/`. That takes minutes, longer than the limit of a single
command, so the run goes to the background and the result is read on completion. While it runs,
start no other gates: the load would be created by the review itself, and under load a mutant's
status lies both ways (`docs/architecture/testing.md`, "Timeouts and errors").

`mutation` mutates the area from the diff. Assemble it from the tree you were started in, naming
the PR tree:

```bash
cd <the tree you were started in>
make mutation-area pr=<N> tree=<the PR tree>
cd <the PR tree>
```

`tree` is what makes the area the PR's: `git` and the container that reads the configs run there,
so a source the PR adds stays in the area and the exclusions are those of the PR's
`stryker.config.mjs`. Without it the target reads the files and the configs of the tree it is
called from.

The target prints the area one path per line and says on stderr why a changed file was left out:
the rule, from the mirror of a spec to the exclusions of `stryker.config.mjs`, and the reason
behind each of its steps are in the docstring of `scripts/review/mutation_area.py`. A non-zero exit
code is not an empty area: the gate is `n-a` with the reason from the `Stopped:` line, and the
verdict is BLOCKED, as on a checker crash — nobody checked the PR's mutants.

The area is empty — do not run `make mutation`, give `n-a` with the reason "the area is empty" and
the lines of stderr: the PR edited, say, only the database specs (PR #372). A run with the score
`NaN` is `n-a` too, not `ok`: not a single mutant of the area got into the score, and the green
exit checked nothing.

At a threshold of 100, silencing a survivor with a mark is cheaper than writing a test, so a green
run does not yet mean there are no survivors. Read the new marks in the diff together with their
reason — under either gate:

```bash
gh pr diff <N> | awk '/^\+\+\+ /{f=substr($0,7); next} /^\+.*Stryker disable/{print f": "$0}'
```

The reason is checked against "Working through survivors" in `docs/architecture/testing.md`: the
mutant is equivalent, or the behaviour is not required and an issue is filed for it — then the mark
links to it. The reason does not hold — the gate is `fail`, as with a live survivor: the mark only
hid it.

#### The author's run record

`make mutation` writes a run record, and the author publishes it in the PR; the format is in
`docs/architecture/testing.md`, "The run record". Check it before running the target: under
`mutation-full` right away, under `mutation` once the area is assembled and not empty. The target
is called from the tree you were started in, as `make mutation-area` is, and needs no `tree`: the
PR head and the diff between two commits come from the objects the trees share.

```bash
make mutation-record pr=<N> gate=mutation area="<the area>" [rebuild=1]
make mutation-record pr=<N> gate=mutation-full [rebuild=1]
```

`rebuild=1` goes in when the `rebuild` gate is on. The target takes the last comment of the PR
that starts with the record's marker and was posted from the account `gh` works as, and checks the
four conditions of acceptance; which they are and the reason behind each are in the docstring of
`scripts/review/mutation_record.py`. The first line of its answer:

- `accepted <link>` — the record replaces your run. The lines under it give the record's head,
  `exit`, `score` and the survived and uncovered mutants. The `head:` line says `not the PR head`
  when the record went on another commit with the same tree.
- `accepted if the table turns on none of rebuild, mutation, mutation-full: <link>` — every other
  condition holds, but the record went on another commit whose tree differs, and the answer lists
  the files changed between the two. Apply to that list the table of
  `docs/agents/review-gates.md`, "Changes that affect the mutation run", as `/review-pr` applies
  it to the PR diff. A file of a row decided by content (`package.json`, `package-lock.json`, the
  `Makefile`, a tool of the run with its comments-only rule) — read its hunk with the command the
  answer gives. None of the three gates on — the record is accepted as in the first line; one is
  on — run the target yourself.
- `refused: <link>` — every reason follows on a `- ` line of its own; run the target yourself. A
  list of changed files under the reasons is not a reason: it is there because the heads differ,
  and the table was not applied to it.
- `Stopped: <reason>` on stderr with a non-zero exit code — `gh` or `git` failed and the record was
  not checked; run the target yourself and name the reason in the `mutation:` line.

An accepted record replaces only the run; the rest of the gate stays the same. The outcome is the
record's `exit` instead of the target's exit code, the score is its `score`, the survived and
uncovered mutants are its list. The score `NaN` is `n-a`; a red record means a repeat on every
file with survivors ("Red"); new `Stryker disable` marks in the diff are read together with their
reason.

Refusing the record is not a review finding and does not affect the verdict: a process error must
not cost a round. Where the run came from and why the record was not accepted is told by the
`mutation:` line of the verdict (step 5). It says "accepted record" and gives the link rather than
naming the author: the reviewer's record of the previous round lies in the same thread and is
accepted on a par with the author's, and the author's comment cannot be told from it — the account
is the same. A record accepted from another head (its `head:` line says `not the PR head`) — name
its head there too and say that nothing under the mutation gates came in since: otherwise the
verdict does not show that the run went on a commit other than the PR's.

Publish the record of your own run in the PR as soon as it finishes: a repeat from "Red" overwrites
`reports/mutation/record.md`, and the cleanup deletes the temporary tree together with it. Copy the
record into a temporary file outside the repository, append an empty line and the signature from
`CLAUDE.md` ("Agent signature on GitHub") and publish: `gh pr comment <N> --body-file <file>`. The
records of repeats are not published — the gate's record stays the last in the PR. The `--no-post`
flag cancels this publication too: it comes in the arguments, and from `pr-deep-review` together
with the gates.

### Red

Red in `make -n` and `sh -n` is unambiguous by itself. Red in `mutation` and `mutation-full` —
repeat on every file with survivors, `make mutation files="<file>"`: the threshold of 100 has no
margin, and on a loaded machine a mutant's status lies both ways
(`docs/architecture/testing.md`, "Timeouts and errors"). There is no need to repeat the whole area:
the mutants of other files do not affect the status of these.

A repeat refines the red but does not turn it green: the gate is `fail` whatever the outcome. The
survivor stands in the `clear-text` output again — the same mutator, place and `+` line — then the
red is confirmed. It does not — add to it in "Red" the note "possible drift: recheck on an idle
machine". The status of the repeat does not prove drift: under load a survivor hides both under
`Timeout` and under `Killed` with the ordinary message of a spec, and review has no idle machine.

Red in `build`, `typecheck`, `test`, `lint`, `format-check` or the mutation gates — compare with the
base if you doubt it was brought by this PR: create a worktree on `origin/main` at
`<main>-review-<N>-base` next to the main worktree, copy `.env` into it, move into it and run
**only the failed** command. That is a temporary tree too, and it is removed the same way.

## Step 3. Documentation drift

The `docs` gate is off — skip the step whole: the diff touches no `*.md`.

The rule for the moment of writing is the "Editing documentation" section of `CLAUDE.md`. Read it
rather than retell it from memory: the checklist below gives the mechanics, the criteria live there.
The author checked their paragraph themselves, and a duplicate they cannot see by construction: they
did not search, because they did not suspect the same thing was already said in another file. You
are the second reader here, and your area is cheap — only the changed lines, not the corpus.

Of the rule's four checks, three are here: the issue link, the derivable list, the duplicate. The
first — checking every statement against the code — the diff does not make cheaper: it takes
opening the code under every paragraph and costs as much as a one-off cleanup of the corpus. It is
not in this step, and the "Checked" line does not promise it. "Run, do not eyeball" does not apply
to step 3: `ok` here means "read the added lines, no findings".

The `*.md` hunks with the file name on every line — both the added lines and the context around
them come from here:

```bash
gh pr diff <N> | awk '/^diff --git /{md=0} /^\+\+\+ /{f=substr($0,7); md=(f ~ /\.md$/); next} md && /^[-+ ]/{print f"|"$0}'
```

The reset on `diff --git` is required: the `--- a/<next file>` header comes before `+++` and without
the reset is attributed to the previous file. The file name on the line is required too: without it
there is nothing to open later.

A move or a reformat brings old lines up as added: cutting `docs/architecture.md` into subsystems
(PR #221) gave 947 added `*.md` lines and every link of the corpus at once, none of which was
written in that PR. A line that did not change in substance is not a finding, whatever subsection
it surfaced in.

### Issue links

From that output — the added lines with links, with two lines of context, and the state of every
number:

```bash
… | grep -B2 -E '\|\+.*[^A-Za-z0-9_./-]#[0-9]+'
gh api repos/{owner}/{repo}/issues/<M> \
  -q '[.number, (if .pull_request then "PR" else "issue" end), .state] | @tsv'
```

The context is needed because the lines in the docs are wrapped: the statement regularly stands
above its link, and the matched line often holds nothing but `[#41](...)`. Requiring a digit after
`#` cuts off the shebang and the `#N` placeholders; the character class before `#` cuts off anchors
with a number (`architecture.md#41`).

The state comes through `gh api`, not `gh issue view`: on a PR number that one does not fail but
silently returns `MERGED`, and the rule "the state is not `open` — a finding" would fire on every
link to a neighbouring PR.

`issue` + `closed` is a candidate, not a finding: apply the rule's test to the paragraph. It
survived the closing — the link stands as a source and there is no reason to touch it:
`test/fixtures/fonts/README.md` explains through the closed #153 where the files of the wrong format
in the repository came from. It did not survive — a finding.

### Lists and duplicates

They cannot be told apart mechanically: a backtick detector catches prose — it cannot tell an
enumeration in the text from a list. Read yourself — but only the added lines, there are fewer of
them than the whole output:

```bash
… | awk -F'|' '$2 ~ /^\+/'
```

- **A derivable list** is a finding by the rule's criterion. Name in it the command or the file the
  list is derived from; you named neither — the criterion is not met, and there is no finding.
- **A duplicate** is a finding: run for the author the `grep` the rule requires of them before
  writing, by the key identifier of the new paragraph. Found in another file — what was found gets
  edited: two copies drift apart silently from then on, and nobody will be there to notice.

A finding here is REQUEST_CHANGES by the rules of step 5, no weaker than a red run: a lie in the
documentation lives until the next cleanup, and it costs the reader more than the edit costs the
author.

## Cleaning up the temporary trees

Right after step 3, in both modes, remove every temporary tree you created: the PR tree from step 1
and the `origin/main` tree from "Red". Steps 4–6 do not need it, and a failed cleanup before step 5
still makes it into the verdict. The run broke off earlier — the cleanup goes before the stop. For
each tree:

```bash
cd <the tree you were started in>
make review-tree-remove path=<temporary path>
```

The target is called from the tree you were started in, by the hard rules. It takes the tree's application down together with its image
and volume and removes the tree; what it runs, in which order and why is in the docstring of
`scripts/review/tree_remove.py`.

`Not cleaned up: <path> — <reason>` in its output — put the line into the report as it is, so that a
human removes the tree: the application failed to go down and the tree is kept on purpose, or the
tree was not removed. `Refused:` — the path is not a temporary review tree (step 1); nothing was
removed.

The price: the next review round of the same PR builds the image anew — the throwaway container
rebuilds it only when there is no image (the comment on the `rebuild` target in the `Makefile`), and
after the cleanup there is none. That is minutes of build per round against an image left on disk
by every one.

## Step 4. Issue compliance

The run answers "is anything broken", the verdict answers "can it be merged". The second cannot be
checked without the issue: a green run on a PR that touches only the `Makefile` means only that
nothing failed, not that what was asked for was done.

Find the issue link in the PR body (`Closes #N`, `Fixes #N`, `#N`):

```bash
gh pr view <N> --json number,title,body,headRefName,baseRefName,files
gh issue view <M> --json number,title,body,labels
```

- No issue link → verdict **BLOCKED**: there is nothing to check the acceptance criteria against.
- There is a link → write out the list of criteria from the issue body (explicit items or implicit
  requirements) and give each `met` / `not met` / `not covered by the diff` with a file and a line.
- Check the reverse direction: whether the diff has changes the issue did not ask for. By the
  repository rule one branch is one coherent task; unrelated changes in the same PR are grounds for
  `REQUEST_CHANGES`.

Check along the way: `baseRefName` must be `main`.

If the diff touches `CLAUDE.md`, `docs/**`, `README.md` or adds a new document, the lines it
writes must be English; code identifiers stay as they are. Russian outside the changed lines is
a leftover, not a finding: #385 translates it area by area.

## Step 5. Verdict

### Run number

Verdicts on one PR must differ. The run identifier is a count of the hidden
`<!-- pr-light-check` marker in the PR comments, not a date and not a guess.

```bash
gh pr view <N> --json comments -q '[.comments[].body | select(contains("<!-- pr-light-check"))] | length'
gh pr view <N> --json headRefOid -q '.headRefOid[0:7]'
```

The first command gives the number of past runs, `K-1`; your run is `K`. The `pr-light-check`
marker is its own and does not mix with the `pr-deep-review` marker: those are separate counters.

### Text

```
## Light check of PR #<N> — issue #<M> · run #<K> · commit <sha>

**Verdict:** APPROVE | REQUEST_CHANGES | BLOCKED

Checked: the run + the changed documentation lines + issue compliance
Not checked: invariants, bugs, smells, overlaps with open PRs, documentation outside the diff

### Issue compliance
- <criterion> — met / not met / not covered (file.ts:42)

### Run
rebuild: done/not needed · build: ok/fail/n-a · typecheck: ok/fail/n-a · test: ok/fail/n-a · lint: ok/fail/n-a · format-check: ok/fail/n-a · python: ok/fail/n-a
mutation: ok/fail/n-a — <score from Final mutation score>, <the whole src/ or the area files> · accepted record, <link> (head <sha> is earlier — nothing under the mutation gates came in since) | own run — <why the record was not accepted> (n-a — the reason)
make -n <target>: ok/fail — <what the expansion showed>
sh -n <script>: ok/fail (+ dash: ok/fail/n-a)
Not run: <check> — <reason>
Not cleaned up: <temporary path> — <the reason from the make review-tree-remove output>

### Documentation
issue links: ok/findings/n-a · <file.md> "<quoted line>" — #<M> is closed, the paragraph presents it as a live problem
lists and duplicates: ok/findings/n-a · <file.md> "<quoted line>" — <what prints the list or where the duplicate lies>

### Red
- <command> — <the first meaningful line of the error> [brought by this PR | red on the base too]

### Summary
<1–3 sentences: it can be merged, or what exactly to fix>

_🤖 Posted by Claude Code from the owner's account · [session](<session link>)_

<!-- pr-light-check run=<K> head=<sha> -->
```

The "Not checked" line is required and must not be dropped: without it a green verdict reads as a
full review, which it is not. The `docs` gate is off — move documentation from "Checked" to "Not
checked"; not a single run gate — move the run the same way.

The signature is required: the verdict goes out from the owner's account and without it reads as
written by the owner ("Agent signature on GitHub" in `CLAUDE.md`). No session link — leave
`_🤖 Posted by Claude Code from the owner's account._`

The marker is the last line, exactly in this form and without indentation: the next run counts its
number by it. The signature goes before it: the marker is invisible in the feed and does not work as
a signature.

### Verdict rules

- **APPROVE** — everything that ran passed and the issue criteria are met. An empty run (a
  documentation-only diff) does not stand in the way.
- **REQUEST_CHANGES** — there is red brought by this PR, or a documentation finding, or an unmet
  issue criterion, or changes the issue did not ask for.
- **BLOCKED** — there is nothing to judge by: the PR is not linked to an issue, or the run did not
  start (no Docker, no `.env`) and there is nothing to confirm it works with, or a mutation gate
  broke off on a checker crash on the repeat too or `make mutation-area` failed ("mutation and
  mutation-full"): nobody checked the PR's mutants.

Red that is red on the base too does not change the verdict — put it on a separate line as
inherited.

You came to REQUEST_CHANGES on the third run (`K >= 3`) because of a documentation or issue
finding — give BLOCKED instead: here it means not "nothing to judge by" but an exhausted round of
fixes, and say in "Summary" that a human is needed next. These grounds are counted over the
cumulative diff — `gh pr diff <N>` of step 3 and `files` from `gh pr view` of step 4 give the whole
branch against the base, not the last push — so a finding the author disagreed with comes back
word for word on the fifth run too. Red is not counted here: it runs on the current head and goes
out with the fix, so red on the third run is a new breakage, not a round.

## Step 6. PR comment

The verdict goes out as a PR comment. `--no-post` in the arguments — skip this step and just print
the text into the session.

Write the text into a temporary file **outside the repository** (otherwise it gets into the diff)
and publish from the file — that way shell escaping does not mangle the text:

```bash
gh pr comment <N> --body-file <temporary path>
```

- **A new comment on every run, not an edit of the last one.** The history must stay visible
  whole: the `head=<sha>` line shows which commit was green. Do not use `--edit-last`: it edits the
  current user's last comment whatever skill wrote it, and would overwrite the `pr-deep-review`
  verdict.
- Publish exactly the text you printed into the session — with the signature and the marker at the
  end.
- `gh pr comment` failed (no rights, the PR is closed) — do not keep quiet and do not work around
  it: print the verdict into the session and say that publishing failed and why.
