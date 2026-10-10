---
name: pr-light-check
description: Light Pull Request review — a mechanical run of the repository checks by the gates passed in, documentation drift in the changed lines and issue compliance, with a verdict and a PR comment. Run by the /review-pr command, and by the pr-deep-review skill as its mechanical part. Not for ordinary work on code and not for checking uncommitted edits.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(make rebuild), Bash(make build), Bash(make typecheck), Bash(make coverage), Bash(make test-fonts), Bash(make lint), Bash(make format-check), Bash(make review-run:*), Bash(make help), Bash(make token-status), Bash(make -n:*), Bash(sh -n:*), Bash(docker run:*), Bash(make review-test), Bash(make review-tree-create:*), Bash(make review-tree-remove:*), Bash(scripts/bot-token.sh), Bash(cd:*), Bash(ls:*), Bash(cp:*), Bash(grep:*), Bash(awk:*), Read, Grep, Glob, Write
---

<!-- In the source of this file a dollar sign before a digit carries a backslash, and a new one
must too. Before the model reads a skill, Claude Code replaces a dollar sign followed by a digit
with the invocation argument of that index, 0-based, inside fenced blocks as well
(https://code.claude.com/docs/en/skills, "Pass arguments to skills"). An awk field reference is
the same token: unescaped, the first one turns into the PR number. The backslash is dropped on
the way, so the commands reach the model as they are written in awk. Checked by invoking the
skill on Claude Code 2.1.296 (#962). -->

You run the repository checks over the code of a Pull Request and decide whether it can be
merged.

Input: the PR number, the list of gates, the flags. The `/review-pr` command computes the gates;
you do not sort the diff into groups yourself.

This is the light review. Your verdict rests on three things: the run, documentation drift and
issue compliance. Architecture invariants, bug hunting, smells and overlaps with other branches
belong to `pr-deep-review`.

## Two modes

- **Standalone** (called by the `/review-pr` command): you do steps 1–3, then steps 4–6 of
  `standalone.md` next to this file.
- **Mechanical** (called by `pr-deep-review`): you do steps 1–3 and the cleanup, and return the run
  results and the documentation findings as lines. No issue, no verdict, no comment: those belong
  to the caller, and `standalone.md` is not read.

Step 3 is in the mechanical mode because the check has one owner. `pr-deep-review` sees the `*.md`
diff only through you, and a documentation-only PR never reaches it at all. With the check split in
two, the repository would hold two copies of the checklist, and the first edit would set them apart.

## Hard rules of the role

- **You fix nothing.** The result is a report and a verdict. Something red — say so and suggest
  fixing it separately. Do not edit files and do not run `--fix` along the way.
- `cp` and `Write` are granted for the records the steps below prescribe and for nothing else:
  creating a file is an edit too.
- **Run, do not eyeball.** A check you did not run is `n-a`, not `ok`. "Looks correct", "the syntax
  is fine" and "should work" without the output of a command are forbidden.
- **Allowlist.** You really run only `make review-run` and what step 2 and "Cleaning up the
  temporary trees" of `fallback.md` list. Everything else, any other `Makefile` target included, is
  never run, even if a gate points at it. Such a check goes into the report as a "Not run" line
  with the reason.
  The list is an allowlist rather than a denylist on purpose: a new `Makefile` target counts as
  dangerous until it is written in here.
- **What was not run is reported.** Every check a gate turned on and you did not perform goes into
  the report with the reason.
- **The review's tools come from the tree you were started in; the gates run the PR's code.** Call
  a target that runs an action of `scripts/review/` from the tree you were started in, never from a
  temporary one. In a temporary tree the `Makefile` and `scripts/review/` are the PR's code under
  review, so the PR would be reviewed by its own version of the action. A PR opened before an action
  was merged has no such target at all: a re-review of PR #524 got a `No rule to make target …`
  error. An action takes what it reads of the PR from the PR tree named in its arguments or from the
  objects the trees share.
- **A temporary tree does not outlive the run.** "Cleaning up the temporary trees" of `fallback.md`
  removes every tree you created in step 2 whatever the outcome, a red gate, BLOCKED and a stop
  halfway included.

## Step 1. The run

A run gate is any gate of `KNOWN` or `BY_SKILL` in `scripts/review/review_run.py`. None of them —
skip steps 1–2 whole: no checkout, no database, no containers. Building a project in which not a
single line of executable code changed costs minutes and cannot yield a single finding. Step 3
needs no checkout either: it reads the diff through `gh`.

At least one run gate — call the target from the tree you were started in, with every gate as it
came and the flags:

```bash
make review-run pr=<N> gates="<the gates>" [flags="--no-post"]
```

The target takes minutes, longer than the limit of one command. Run it in the background, do step 3
while it goes and read the report on completion. What it runs, in which order and why is in the
docstring of `scripts/review/review_run.py`. The report:

- `Head:` — the commit the gates ran on.
- `Checks` — the gates line and the `mutation-full:` line go into the verdict as they are.
- `Not run: <checks> — <reason>` — into the report as it is.
  - A reason that ends in `by fallback.md` leaves the check to you (step 2).
  - `the tree was not created` with `no .env` among the reasons means that `make worktree-init` is
    needed here. Say so and do not run it yourself: it takes a slot of the token pool.
- `Not cleaned up:` and `Refused:` — as "Cleaning up the temporary trees" of `fallback.md` says.
- `Red` — every red command with the first meaningful line of its error and an excerpt. The whole
  logs lie in the directory of the `Logs:` line.
  - `Missing script` in the excerpt of a container gate is not a review finding but a missed
    `rebuild`: say so. The PR adds or renames an npm script, the script lives in the image, and
    the `/review-pr` table did not turn `rebuild` on.
- `Yours to read` — the new `Stryker disable` marks (below).

The `mutation-full` gate runs no mutants: neither the author nor you runs `make mutation`, and the
files the PRs changed run once per batch of recorded issues (`docs/agents/review-gates.md`, the
paragraph on `mutation-full`). Its line:

- `ok — recorded: …` — the issue the PR closes is recorded in a batch together with this PR, or,
  when the PR closes no issue, the PR is recorded with whatever issue.
- `fail — not recorded: …` — red brought by this PR, and it stands in `Red` too. The author records
  it with `make mutation-full-record issue=<M> pr=<N>`: `<M>` is the issue the PR closes, or for a
  stage PR that closes none, the parent it links as a bare `#N`.
- `n-a` with any reason (the batch was not checked, the run was interrupted) — the verdict is
  BLOCKED: nobody checked that the change reaches a batch run.

A new `Stryker disable` mark needs reading. Check its reason against "Working through survivors"
in `docs/architecture/testing.md`. The reason does not hold — red brought by this PR: put the mark
into `Red`. The mark hides a survivor from the batch run too, and at a threshold of 100 silencing
a survivor with a mark is cheaper than writing a test.

## Step 2. The checks the run leaves to you

Read `fallback.md` next to this file when the report of step 1 has any of:

- a `Not run` line whose reason ends in `by fallback.md`;
- a `Red` section;
- a `Not cleaned up:` or `Refused:` line.

Its step 2 has a section for each such check, and its "Cleaning up the temporary trees" removes the
trees that step creates. A report with none of them needs nothing from it.

## Step 3. Documentation drift

The `docs` and `comments` gates are both off — skip the step whole: the diff touches no `*.md`, and
its `.ts` hunks, if any, change code. One of the two is off — skip its part: the `*.md` checks below
belong to `docs`, "Changed comments" to `comments`.

The rule for the moment of writing is the "Editing documentation" section of `CLAUDE.md`. Read it
rather than retell it from memory: the checklist below gives the mechanics, the criteria live there.
You are the second reader. The author checked their paragraph themselves, but a duplicate they
cannot see by construction: they did not search, because they did not suspect the same thing was
already said in another file. Your area is cheap: only the changed lines, not the corpus.

Of the rule's four checks, three are here: the issue link, the derivable list, the duplicate. The
first, checking every statement against the code, the diff does not make cheaper: it takes opening
the code under every paragraph and costs as much as a one-off cleanup of the corpus.

- For `*.md` that check is not in this step, and the "Checked" line does not promise it.
- The changed comments get it (below), because the code a comment describes lies a few lines from
  it.

"Run, do not eyeball" does not apply to step 3: for `*.md`, `ok` means "read the added lines, no
findings".

The `*.md` hunks with the file name on every line — both the added lines and the context around
them come from here:

```bash
gh pr diff <N> | awk '/^diff --git /{md=0} /^\+\+\+ /{f=substr(\$0,7); md=(f ~ /\.md$/); next} md && /^[-+ ]/{print f"|"\$0}'
```

- The reset on `diff --git` is required: the `--- a/<next file>` header comes before `+++`, and
  without the reset it is attributed to the previous file.
- The file name on the line is required too: without it there is nothing to open later.

A move or a reformat brings old lines up as added. Cutting `docs/architecture.md` into subsystems
(PR #221) gave 947 added `*.md` lines and every link of the corpus at once, none of which was
written in that PR. A line that did not change in substance is not a finding, whatever subsection it
surfaced in.

### Issue links

From that output take the added lines with links, with two lines of context, and the state of every
number:

```bash
… | grep -B2 -E '\|\+.*[^A-Za-z0-9_./-]#[0-9]+'
gh api repos/{owner}/{repo}/issues/<M> \
  -q '[.number, (if .pull_request then "PR" else "issue" end), .state] | @tsv'
```

- The context is needed because the lines in the docs are wrapped: the statement regularly stands
  above its link, and the matched line often holds nothing but `[#41](...)`.
- Requiring a digit after `#` cuts off the shebang and the `#N` placeholders.
- The character class before `#` cuts off anchors with a number (`architecture.md#41`).
- The state comes through `gh api`, not `gh issue view`. On a PR number `gh issue view` does not
  fail but silently returns `MERGED`, and the rule "the state is not `open` — a finding" would fire
  on every link to a neighbouring PR.

`issue` + `closed` is a candidate, not a finding: apply the rule's test to the paragraph.

- The paragraph survived the closing — the link stands as a source, and there is no reason to touch
  it. `test/fixtures/fonts/README.md` explains through the closed #153 where the files of the wrong
  format in the repository came from.
- It did not survive — a finding.

### Lists and duplicates

They cannot be told apart mechanically: a backtick detector catches prose, since it cannot tell an
enumeration in the text from a list. Read yourself, but only the added lines, which are fewer than
the whole output:

```bash
… | awk -F'|' '\$2 ~ /^\+/'
```

- **A derivable list** is a finding by the rule's criterion. Name in it the command or the file the
  list is derived from. You named neither — the criterion is not met, and there is no finding.
- **A duplicate** is a finding. Run for the author the `grep` the rule requires of them before
  writing, by the key identifier of the new paragraph. Found in another file — the finding asks to
  edit what was found: two copies drift apart silently from then on, and nobody will be there to
  notice.

A finding here is REQUEST_CHANGES by the rules of step 5 (`standalone.md`), no weaker than a red
run. A lie in the documentation lives until the next cleanup, and it costs the reader more than the
edit costs the author.

### Changed comments

The `comments` gate is on when every `.ts` of the PR changes only comments. What counts as a
comment, and why such a PR gets this check instead of the bug hunt, is in
`docs/agents/review-gates.md`. The `.ts` hunks come the way the `*.md` ones do, with three
differences:

- The file name is taken from the `diff --git` line, not from `+++`, and the old name counts too. A
  deleted `.ts` has `+++ /dev/null`, and one renamed to `.js` has no `.ts` in its new name. Their
  removed lines are exactly the code the check below must not miss.
- The `@@` headers are kept: they give the line numbers for the `<file.ts:line>` of the report and
  for reading the code around.
- The file headers that make a `.ts` code whatever its hunks hold are printed too: added, deleted,
  renamed, copied, a mode change. A rename has no hunks and would not show up otherwise.

Read the code at the PR head from git objects, not from the tree you were started in: it stands on
another branch.

```bash
gh pr diff <N> | awk '/^diff --git /{f=$NF; sub(/^b\//,"",f); ts=(f ~ /\.ts$/ || \$3 ~ /\.ts$/); h=1; next} /^@@/{h=0} ts && (!h || /^(new|deleted) file mode|^(old|new) mode|^(rename|copy) (from|to) /){print f"|"\$0}'
gh pr view <N> --json headRefOid -q .headRefOid
git fetch -q origin pull/<N>/head
git show <sha>:<file> | awk 'NR>=<from> && NR<=<to> {print NR": "\$0}'
git grep -n -w '<identifier>' <sha>
```

For every added comment, two checks:

- **Against the code.** Open what the comment describes at the head: the declaration or the block
  under it, the line it ends. A claim that reaches further — a caller, another module, "only",
  "always", "never" — is checked where it points, with `git grep` at the head. The code does not
  bear the claim out — a finding: quote the comment and say what the code does.
- **The same claim elsewhere.** Search the key identifier of the comment at the head over the whole
  tree, `*.md` and comments alike. A place that still says what the PR corrected, or contradicts the
  new comment, is a finding: the PR fixed one copy and left the other one lying, and from then on
  they drift apart unseen.

`ok` in the `comments` line means that every claim of the added comments was set against code
opened at the head. A comment read only against the context of its own hunk is not checked. A
finding here counts as a documentation finding in step 5 (`standalone.md`): a comment is
documentation too.

A `.ts` that changes code means the table was applied wrong and the PR needed the full review. What
counts as code is in `docs/agents/review-gates.md`, "Comments-only diffs", the file headers above
included.

- Put the line into the report.
- In the standalone mode the verdict is BLOCKED (step 5, `standalone.md`).
- The mechanical mode needs nothing more: the caller runs because the diff has executable code, and
  its bug hunt reads the whole diff.

## Steps 4–6

The standalone mode goes on with `standalone.md` next to this file: issue compliance, the verdict
and the PR comment. The mechanical mode ends here and returns the lines of steps 1–3 to the caller.
