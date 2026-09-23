---
name: pr-light-check
description: Light Pull Request review — a mechanical run of the repository checks by the gates passed in, documentation drift in the changed lines and issue compliance, with a verdict and a PR comment. Run by the /review-pr command, and by the pr-deep-review skill as its mechanical part. Not for ordinary work on code and not for checking uncommitted edits.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(make review-run:*), Bash(grep:*), Bash(awk:*), Read, Grep, Glob, Write
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
- **Mechanical** (called by `pr-deep-review`) — you do only steps 1–3 and return the run results
  and the documentation findings as lines. No issue, no verdict, no comment: those belong to the
  caller. The run still publishes the record of its own mutation run (step 1): it is not a verdict
  but a fact of the run.

Step 3 is part of the mechanical mode because the check has one owner. `pr-deep-review` sees the
`*.md` diff only through you, and a documentation-only PR never reaches it at all; with the check
split in two, the repository would hold two copies of the checklist, and the first edit would set
them apart.

## Hard rules of the role

- **You fix nothing.** The result is a report and a verdict. Something red — say so and suggest
  fixing it separately; do not edit files and do not run `--fix` along the way. `Write` is granted
  for the verdict text of step 6 and only for it: creating a file is an edit too.
- **Run, do not eyeball.** A check that did not run is `n-a`, not `ok`. "Looks correct", "the
  syntax is fine", "should work" without the output of a command are forbidden. The one exception
  is a mutation run record the run accepted: it is written by `make mutation` itself, not retold
  by the author.
- **Checks run only through `make review-run`.** Its gates and the targets it leaves out on purpose
  are the allowlist at the top of `scripts/review-run.sh`: a new `Makefile` target counts as
  dangerous until it is written in there, and a gate it does not know comes back as a "Not run"
  line. No `Makefile` target is run by hand, even if a gate points at it.
- **What was not run is not hushed up.** Every check a gate turned on and that did not run goes
  into the report with the reason: the target prints its "Not run" lines, and a check of your own
  reading that you did not do gets one from you.
- **A temporary tree does not outlive the run.** The target removes its trees whatever the
  outcome. A tree it could not remove comes as a "Not cleaned up" line and goes into the report as
  it is, so that a human removes it.

## Step 1. The run

The run gates are `rebuild`, `build`, `typecheck`, `test`, `lint`, `format-check`, `make-targets`,
`scripts`, `mutation` and `mutation-full`. None of them — skip steps 1 and 2 whole: no database, no
tree, no containers. Building a project in which not a single line of executable code changed costs
minutes and cannot yield a single finding. Step 3 needs no checkout either: it reads the diff
through `gh`.

At least one — one call, from the tree you were started in:

```bash
make review-run pr=<N> gates="<the gates as they came>" targets="<changed targets>" flags="<the flags as they came>"
```

The target brings the database up from this tree, takes the head of the PR into a temporary tree,
runs the gates there, accepts or refuses the last run record in the PR, removes the tree and prints
the report. Why each of these steps is the way it is — the comments of `scripts/review-run.sh`; the
area of the `mutation` gate — `scripts/mutation-area.sh`.

- `gates` — every gate that came in: the target takes its own and passes over the rest.
- `targets` — only under `make-targets`: the targets whose recipe or `##` line the `Makefile` diff
  changes, and those whose recipe expands a changed variable. Take them from the `Makefile` hunks of
  `gh pr diff <N>` before the call.
- `flags` — `--no-post` cancels the publication of the target's own mutation run record as well.

A mutation gate on — call it in the background (`run_in_background`) and wait for the completion
notification: a run of an area takes minutes, of the whole `src/` a quarter of an hour, while one
command is cut off at ten minutes. Until it ends, run nothing that loads the machine: under load a
mutant's status lies both ways (`docs/architecture/testing.md`, "Timeouts and errors"). Step 3
reads through `gh` alone and may go meanwhile. No mutation gate — the foreground with the
ten-minute limit (`timeout: 600000`) is enough.

## Step 2. Reading the report

The lines of **"Checks"** — the `rebuild … format-check` line, `mutation:`, the substitution of
`make mutation`, `sh -n`, "Not run", "Not cleaned up" — go into the verdict as they are. So do the
items of **"Red:"**: a command, the first meaningful line of its error, whether this PR brought it
(the failed command is repeated on `origin/main`), and the lines that explain it. The whole logs lie
in the directory the first line of the report names.

The run did not start — a "Not run" line with every gate: there is nothing to confirm the PR works
with. Step 3 is still done: `gh` is enough for it.

An own mutation run in place of a refused record is not a finding and does not affect the verdict:
a process error must not cost a round. The `mutation:` line says why the record was refused.

**"Yours to read:"** is what a command does not judge:

- `make -n <target>` — the expansion of a changed target: whether the variable values were
  substituted, whether an argument is left empty, whether a multi-line `files` got glued into one
  command. For a new or renamed target also: whether it has a `## description` (its `make help`
  line is printed), whether it is in `.PHONY` (printed), whether the recipe itself rejects a
  missing required parameter (the example is `migrate-create`). Your line in "Checks" is
  `make -n <target>: ok/fail — <what the expansion showed>`.
- The new `Stryker disable` marks. At a threshold of 100 a mark is cheaper than a test, so a green
  run does not yet mean there are no survivors. Check each reason against "Working through
  survivors" in `docs/architecture/testing.md`: the mutant is equivalent, or the behaviour is not
  required and an issue is filed that the mark links to. The reason does not hold — the mutation
  gate is `fail`, as with a live survivor: the mark only hid it.
- A record accepted on a condition: its head is earlier than the PR's, and since then files changed
  whose gate in `docs/agents/review-gates.md` depends on the content of the change; their hunks
  follow. A diff of comments only leaves `mutation-full` off, and the `Makefile` turns it on only
  through the `mutation` recipe or a variable it expands. The record holds — write its `mutation:`
  line without the condition. It does not — call the target once more with the mutation gate alone
  and `record=refuse`: its own run replaces the record.
- A file red "on origin/main too": the target prints the survivors of both runs. The lines move
  with the PR's edits, so match a survivor by its mutator and replacement: one the base does not
  have is brought by this PR.

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
rebuild: done/not needed · build: ok/fail/n-a · typecheck: ok/fail/n-a · test: ok/fail/n-a · lint: ok/fail/n-a · format-check: ok/fail/n-a
mutation: ok/fail/n-a — <score from Final mutation score>, <the whole src/ or the area files> · accepted record, <link> (head <sha> is earlier — nothing under the mutation gates came in since) | own run — <why the record was not accepted> (n-a — the reason)
make -n <target>: ok/fail — <what the expansion showed>
make mutation, the MUTATION_DIRTY substitution: ok/fail — <the three values>
sh -n <script>: ok/fail (+ dash: ok/fail/n-a)
Not run: <check> — <reason>
Not cleaned up: <temporary path> — <the first meaningful line of the error>

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
  start (no Docker, no `.env`) and there is nothing to confirm it works with, or the mutation line
  says the run broke off on a checker crash and so did its repeat: nobody checked the PR's
  mutants.

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
