---
name: pr-light-check
description: Light Pull Request review — a mechanical run of the repository checks by the gates passed in, documentation drift in the changed lines and issue compliance, with a verdict and a PR comment. Run by the /review-pr command, and by the pr-deep-review skill as its mechanical part. Not for ordinary work on code and not for checking uncommitted edits.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(make rebuild), Bash(make build), Bash(make typecheck), Bash(make coverage), Bash(make lint), Bash(make format-check), Bash(make mutation:*), Bash(make review-run:*), Bash(make help), Bash(make token-status), Bash(make -n:*), Bash(sh -n:*), Bash(docker run:*), Bash(make review-test), Bash(make review-tree-create:*), Bash(make review-tree-remove:*), Bash(scripts/bot-token.sh), Bash(cd:*), Bash(ls:*), Bash(cp:*), Bash(touch mutation-dirty-probe), Bash(rm mutation-dirty-probe), Bash(grep:*), Bash(awk:*), Read, Grep, Glob, Write
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
  those belong to the caller. The exception is the record of your own mutation run ("Your own
  mutation run"): it is not a verdict but a fact of the run, and you publish it.

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
  is an accepted mutation run record of the author (step 1): it is written by `make mutation`
  itself, not retold by the author.
- **Allowlist.** You may really run only `make review-run` and what is listed in step 2 and in
  "Cleaning up the temporary trees". Everything else — including any `Makefile` target not listed
  there — is never run, even if a gate points at it; such a check goes into the report as a "Not
  run" line with the reason. The list is an allowlist rather than a denylist on purpose: a new
  `Makefile` target counts as dangerous until it is written in here.
- **What was not run is not hushed up.** Every check a gate turned on and you did not perform goes
  into the report with the reason.
- **The review's tools come from the tree you were started in, the gates run the PR's code.** A
  target that runs an action of `scripts/review/` is called from the tree you were started in, never
  from a temporary one: there the `Makefile` and `scripts/review/` are the PR's code under review.
  Called from there, a PR would be reviewed by its own version of the action, and a PR opened
  before an action was merged has no such target at all (a re-review of PR #524 got `No rule to
  make target 'mutation-area'`). What an action reads of the PR it takes from the PR tree named in
  its arguments or from the objects the trees share.
- **A temporary tree does not outlive the run.** Every one you created in step 2 is removed by
  "Cleaning up the temporary trees" whatever the outcome: a red gate, BLOCKED and a stop halfway
  included.

## Step 1. The run

A run gate is any of `rebuild`, `build`, `typecheck`, `test`, `lint`, `format-check`, `python`,
`mutation`, `mutation-full`, `make-targets` and `scripts`. None of them — skip steps 1–2 whole: no
checkout, no database, no containers. Building a project in which not a single line of executable
code changed costs minutes and cannot yield a single finding. Step 3 needs no checkout either: it
reads the diff through `gh`.

At least one run gate — call the target from the tree you were started in, with every gate as it
came and the flags:

```bash
make review-run pr=<N> gates="<the gates>" [flags="--no-post"]
```

It takes minutes, longer than the limit of one command: run it in the background and read the
report on completion; do step 3 while it goes. It takes the head of the PR into a temporary tree,
runs the gates it knows there, checks the author's mutation run record and removes the tree whatever
the outcome; what it runs, in which order and why is in the docstring of
`scripts/review/review_run.py`. The report:

- `Head:` — the commit the gates ran on.
- `Checks` — the gates line and the `mutation:` line go into the verdict as they are.
- `Not run: <checks> — <reason>` — into the report as it is. A reason that ends in `by SKILL.md`
  leaves the check to you (step 2). `the tree was not created` with `no .env` among the reasons
  means that `make worktree-init` is needed here: say so and do not run it yourself, it takes a
  slot of the token pool.
- `Not cleaned up:` and `Refused:` — as "Cleaning up the temporary trees" says.
- `Area:` — the area of the `mutation` gate, for your own run.
- `Red` — every red command with the first meaningful line of its error and an excerpt; the whole
  logs lie in the directory of the `Logs:` line. `Missing script` in the excerpt of a container gate
  is not a review finding but a missed `rebuild`: the PR adds or renames an npm script, the script
  lives in the image, and the `/review-pr` table did not turn `rebuild` on. Say so.
- `Yours to read` — the new `Stryker disable` marks and the files of condition 1 of the record
  (below).

The `mutation:` line needs reading in three cases:

- `n-a — the area was not assembled` — the verdict is BLOCKED, as on a checker crash: nobody
  checked the PR's mutants. `n-a — the area is empty` names why, and the verdict stands: the PR
  edited, say, only the database specs (PR #372). The score `NaN` is `n-a` too: not a single mutant
  of the area got into the score, and the green exit checked nothing.
- The record is accepted on condition 1: the run went on another commit whose tree differs.
  Apply to the files under "Yours to read" the table of `docs/agents/review-gates.md`, "Changes
  that affect the mutation run", as `/review-pr` applies it to the PR diff. A file of a row decided
  by content (`package.json`, `package-lock.json`, the `Makefile`, a tool of the run or a `.ts`
  with their comments-only rule) — read its hunk with the command given under the list. None of the three
  gates on — the record is accepted: in the line, "if the table turns on none of …" becomes
  "nothing under the mutation gates came in since". One is on — your own run.
- A new mark: its reason is checked against "Working through survivors" in
  `docs/architecture/testing.md`: the mutant is equivalent, or the behaviour is not required and
  an issue is filed for it — then the mark links to it. The reason does not hold — the gate is
  `fail`, as with a live survivor: the mark only hid it. At a threshold of 100, silencing a
  survivor with a mark is cheaper than writing a test, so a green run does not yet mean there are
  no survivors.

Refusing the record is not a review finding and does not affect the verdict: a process error must
not cost a round. Where the run came from and why the record was not accepted is told by the
`mutation:` line of the verdict (step 5). It says "accepted record" and gives the link rather than
naming the author: the reviewer's record of the previous round lies in the same thread and is
accepted on a par with the author's, and the author's comment cannot be told from it — the account
is the same.

## Step 2. The checks the run leaves to you

`make-targets`, `scripts`, your own mutation run and the comparison of a red gate with the base are
not in the target yet: its `Not run` lines name them. Each needs a tree of the PR head. Create it
from the tree you were started in:

```bash
make review-tree-create pr=<N>
cd <the path from its Tree: line>
```

It prints `Tree: <path>` and `Head: <sha>`; what it runs and why is in the docstring of
`scripts/review/tree_create.py`. `Stopped: <reason>` — give the checks of this step `n-a` with that
reason; the stop `.env was not copied` names a tree this run did create: remove it there like any
other. The path is `<main>-review-<N>` next to the main worktree, where `<main>` is the name of its
directory: the cleanup refuses a tree named or placed otherwise, so that a wrong argument cannot
remove the main worktree or a task worktree.

The commands below run from the temporary tree, so the `cd` is required: the targets are listed in
`allowed-tools` by exact match (`Bash(make coverage)`), and `make -C <path> coverage` does not fall
under them. `make db-up` is never called from a temporary tree: there it recreates the shared
database on an empty `tmp/pgsql` (the docstring above says how).

This is the allowlist of the step. Also allowed are `make token-status` and `scripts/bot-token.sh`
with no arguments — neither changes anything — and the probe file of the `mutation` substitution
(below, "make-targets"): it is untracked and removed right after the check, so the PR tree stays the
one that was sent. Nothing else.

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

### Your own mutation run

The `Not run` line of a mutation gate ends in `the own run by SKILL.md` when the record was refused
or not checked, and a record accepted on condition 1 leaves the run to you when the table turns on
one of its three gates. Run the target in the PR tree: `make mutation files="<the Area: line>"`
under `mutation`, `make mutation` under `mutation-full`. Which threshold it checks and why a run
without mutants is green — in `docs/architecture/testing.md`, "Threshold". The outcome of the gate
is the target's exit code, the score comes from the `Final mutation score` line. Survived
(`Survived`) and uncovered (`NoCoverage`) mutants `clear-text` prints above it, one by one: the
mutator, `<file>:<line>:<column>` and the replacement. List them in "Red". The score `NaN` is
`n-a`, as in step 1. In the `mutation:` line of the verdict say `own run` and why the record was not
accepted — the reason of the `Not run` line.

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

Publish the record of your own run in the PR as soon as it finishes: a repeat from "Red" overwrites
`reports/mutation/record.md`, and the cleanup deletes the temporary tree together with it. Copy the
record into a temporary file outside the repository, append an empty line and the signature from
`CLAUDE.md` ("Agent signature on GitHub") and publish: `gh pr comment <N> --body-file <file>`. The
records of repeats are not published — the gate's record stays the last in the PR. The `--no-post`
flag cancels this publication too: it comes in the arguments, and from `pr-deep-review` together
with the gates.

### Red

Red in `make -n` and `sh -n` is unambiguous by itself. Red in `mutation` and `mutation-full`, your
own run's or an accepted record's — repeat on every file with survivors,
`make mutation files="<file>"`: the threshold of 100 has no margin, and on a loaded machine a
mutant's status lies both ways (`docs/architecture/testing.md`, "Timeouts and errors"). There is no
need to repeat the whole area: the mutants of other files do not affect the status of these.

A repeat refines the red but does not turn it green: the gate is `fail` whatever the outcome. The
survivor stands in the `clear-text` output again — the same mutator, place and `+` line — then the
red is confirmed. It does not — add to it in "Red" the note "possible drift: recheck on an idle
machine". The status of the repeat does not prove drift: under load a survivor hides both under
`Timeout` and under `Killed` with the ordinary message of a spec, and review has no idle machine.

Red in `build`, `typecheck`, `test`, `lint`, `format-check`, `python` or the mutation gates —
compare with the base if you doubt it was brought by this PR: create a worktree on `origin/main` at
`<main>-review-<N>-base` next to the main worktree, copy `.env` into it, move into it and run
**only the failed** command. That is a temporary tree too, and it is removed the same way.

## Step 3. Documentation drift

The `docs` and `comments` gates are both off — skip the step whole: the diff touches no `*.md` and
its `.ts` hunks, if any, change code. One of the two is off — skip its part: the `*.md` checks below
belong to `docs`, "Changed comments" to `comments`.

The rule for the moment of writing is the "Editing documentation" section of `CLAUDE.md`. Read it
rather than retell it from memory: the checklist below gives the mechanics, the criteria live there.
The author checked their paragraph themselves, and a duplicate they cannot see by construction: they
did not search, because they did not suspect the same thing was already said in another file. You
are the second reader here, and your area is cheap — only the changed lines, not the corpus.

Of the rule's four checks, three are here: the issue link, the derivable list, the duplicate. The
first — checking every statement against the code — the diff does not make cheaper: it takes
opening the code under every paragraph and costs as much as a one-off cleanup of the corpus. For
`*.md` it is not in this step, and the "Checked" line does not promise it; the changed comments get
it (below), because the code a comment describes lies a few lines from it. "Run, do not eyeball"
does not apply to step 3: for `*.md`, `ok` means "read the added lines, no findings".

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

### Changed comments

The `comments` gate is on when every `.ts` of the PR changes only comments; what counts as a
comment and why such a PR gets this check instead of the bug hunt is in `docs/agents/review-gates.md`.
The `.ts` hunks come the way the `*.md` ones do, with three differences:

- the file name is taken from the `diff --git` line, not from `+++`, and the old name counts too: a
  deleted `.ts` has `+++ /dev/null` and one renamed to `.js` has no `.ts` in its new name, and their
  removed lines are exactly the code the check below must not miss;
- the `@@` headers are kept: they give the line numbers for the `<file.ts:line>` of the report and
  for reading the code around;
- the file headers that make a `.ts` code whatever its hunks hold — added, deleted, renamed, copied,
  a mode change — are printed too: a rename has no hunks and would not show up otherwise.

The code is read at the PR head from git objects, not from the tree you were started in — it stands
on another branch:

```bash
gh pr diff <N> | awk '/^diff --git /{f=$NF; sub(/^b\//,"",f); ts=(f ~ /\.ts$/ || $3 ~ /\.ts$/); h=1; next} /^@@/{h=0} ts && (!h || /^(new|deleted) file mode|^(old|new) mode|^(rename|copy) (from|to) /){print f"|"$0}'
gh pr view <N> --json headRefOid -q .headRefOid
git fetch -q origin pull/<N>/head
git show <sha>:<file> | awk 'NR>=<from> && NR<=<to> {print NR": "$0}'
git grep -n -w '<identifier>' <sha>
```

For every added comment, two checks:

- **Against the code.** Open what the comment describes at the head: the declaration or the block
  under it, the line it ends. A claim that reaches further — a caller, another module, "only",
  "always", "never" — is checked where it points, with `git grep` at the head. The code does not bear
  the claim out — a finding: quote the comment and say what the code does.
- **The same claim elsewhere.** Search the key identifier of the comment at the head over the whole
  tree, `*.md` and comments alike. A place that still says what the PR corrected, or contradicts the
  new comment, is a finding: the PR fixed one copy and left the other one lying, and from then on
  they drift apart unseen.

`ok` in the `comments` line means that every claim of the added comments was set against code
opened at the head: a comment read only against the context of its own hunk is not checked. A
finding here counts as a documentation finding in step 5: a comment is documentation too.

A `.ts` that changes code — a line of code, a comment and code on the same line, a tool directive,
or one of the file headers above — means the table was applied wrong and the PR needed the full
review. Put the line into the report; in the standalone mode the verdict is BLOCKED (step 5). The
mechanical mode needs nothing more: the caller runs because the diff has executable code, and its bug
hunt reads the whole diff.

## Cleaning up the temporary trees

`make review-run` removes its tree itself; its `Not cleaned up:` and `Refused:` lines are read as
below. Right after step 3, in both modes, remove every temporary tree you created in step 2: the PR
tree and the `origin/main` tree from "Red". Steps 4–6 do not need them, and a failed cleanup before
step 5 still makes it into the verdict. The run broke off earlier — the cleanup goes before the
stop. For each tree:

```bash
cd <the tree you were started in>
make review-tree-remove path=<temporary path>
```

The target is called from the tree you were started in, by the hard rules. It takes the tree's
application down together with its image and volume and removes the tree; what it runs, in which
order and why is in the docstring of `scripts/review/tree_remove.py`.

`Not cleaned up: <path> — <reason>` in its output — put the line into the report as it is, so that a
human removes the tree: the application failed to go down and the tree is kept on purpose, or the
tree was not removed. `Refused:` — the path is not a temporary review tree (step 2); nothing was
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

Checked: the run + the changed documentation lines + the changed comments against the code + issue compliance
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
comments: ok/findings/n-a · <file.ts:line> "<quoted comment>" — <what the code does | where the same claim still says otherwise | a changed line of code: the full review was needed>

### Red
- <command> — <the first meaningful line of the error> [brought by this PR | red on the base too]

### Summary
<1–3 sentences: it can be merged, or what exactly to fix>

_🤖 Posted by Claude Code from the owner's account · [session](<session link>)_

<!-- pr-light-check run=<K> head=<sha> -->
```

The "Not checked" line is required and must not be dropped: without it a green verdict reads as a
full review, which it is not. The `docs` gate is off — move documentation from "Checked" to "Not
checked", the `comments` gate is off — the comments; not a single run gate — move the run the same
way.

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
  broke off on a checker crash on the repeat too or the area was not assembled (steps 1–2): nobody
  checked the PR's mutants. Or the `comments` gate came with a `.ts` that changes code
  (step 3): the bug hunt that code needed did not run.

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
