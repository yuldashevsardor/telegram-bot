---
description: Solve an issue end to end — implementation, PR, rounds of agent review and a merge on the owner's answer
argument-hint: <issue number or link>
---

You are the author. Arguments: `$ARGUMENTS`.

Your job is to bring the issue to a PR that has passed review and to ask the owner whether it
can be merged. You implement and fix it yourself. A fresh subagent reviews it with the
`/review-pr` command. The owner decides on the merge.

The reviewer is not you, and that is not a formality. A review in the author's session sees
the diff through the author's eyes: it knows why every line is the way it is, and sees neither
the lost knowledge nor the remaining lies. So you do not quietly overrule the reviewer's
findings: you fix them, and if you disagree, you ask the owner (step 6).

## Step 1. Input

The argument is a number, `#N` or a link `.../issues/N`; take `N` from it. A bare number can
turn out to be a PR (`docs/agents/issue-tracker.md`), so check first:

```bash
gh pr view <N> --json number 2>/dev/null && echo "this is a PR"
gh issue view <N> --json number,title,state,body,comments
gh pr list --state open --search "<N> in:body" --json number,title,headRefName
```

- It is a PR, not an issue → stop and say so.
- The issue is closed or already has an open PR → stop and ask what to do.

## Step 2. Implementation

Work as you would without the command. Read the issue with its comments, then what
`CLAUDE.md` tells you to read for the task: `CONTEXT.md`, the subsystem file in
`docs/architecture/`, `docs/architecture/invariants.md`. It is unclear what exactly is asked,
or there is a fork the owner decides — ask through AskUserQuestion and wait for the answer. A
guessed answer turns into a review round over an unmet criterion.

Then the "Workflow" of `CLAUDE.md`, with no exceptions:

1. Choose the branch prefix before the first push: renaming the branch of an open PR closes it.
2. The worktree `<main>-<task>` next to the main worktree, where `<main>` is the name of its
   directory, from `origin/main`; `make worktree-init` in it.
3. Edits, `make check`, `git status -sb`, commit, mutation run, push.
4. A PR into `main` with the issue link — how to write it is in `docs/agents/issue-tracker.md`.
   Without the link the review gives BLOCKED. Right after it — the mutation run record in the PR
   (below).

The mutation run is `make mutation files="<area>"` with the same threshold as the review gate:
without it the author learns of a survived mutant only from the reviewer, at the cost of a round.
The area is the output of `make mutation-area`: the rule of the `mutation` gate, with the
candidates taken from `git diff --name-only origin/main...HEAD` instead of the PR diff. It is passed
as paths, not a glob. An empty output is an empty area, and its stderr says why. The change turned
on the `mutation-full` gate (`docs/agents/review-gates.md`) — `make mutation` without `files`. The run is not part of `make check`: there it would go on every edit.

The run leaves a record — `reports/mutation/record.md`, its format is in
`docs/architecture/testing.md`, "The run record". After the push, post it in the PR as a comment
as is, appending an empty line and the signature from `CLAUDE.md`: by it the reviewer accepts
your run instead of its own (the conditions are in the docstring of
`scripts/review/mutation_record.py`). The first run goes before the PR, and its record is posted
right after the PR is created. Post only the record of a run that happened: the area is empty
and the target did not run — there is nothing to post, and a `record.md` left over from the
previous round would lie about the head. While the run goes, run nothing else, as the reviewer
does on `mutation-full`: under load a mutant's status lies both ways
(`docs/architecture/testing.md`, "Timeouts and errors"), and the review reuses your run.

The last record in the PR also covers the next commit if the changes since its head do not
affect the run: then the target does not run and no new record is posted — the review accepts
the same one (`docs/agents/review-gates.md`, "Changes that affect the mutation run").
`make mutation-record pr=<PR> gate=<the gate> [area="<the area>"]` answers it against the PR head,
so once the PR exists the order is: push, `make mutation-record`, and only then the run and its
record — on a refusal, or when the table turns on one of its three gates for the files the answer
lists. A record of the reviewer's serves as well: it lies in the same thread, and the same rule
applies to it.

Same rule, one case worth naming: a merge of `origin/main` into the branch moves the head although
you edited nothing, and what the merge brings goes through the three gates of that section. Measure
the record against the new `HEAD` before the next round and run again if one of them turns on: a
round opened on a record the review refuses costs the reviewer a run of its own and buys the branch
nothing.

All further commands run in the task worktree.

## Step 3. Review

Count the rounds yourself: `R` = 1, 2, 3. Every round is a new subagent: the Agent tool,
`subagent_type: general-purpose`. The prompt is exactly this and nothing more:

> Run the `review-pr` skill with the argument `<PR>`. When done, print on one line: the verdict,
> the run number, the head.

No description of the implementation, no "what to pay attention to", none of your past answers
to findings: any of it gives the review the author's eyes back. Wait for the subagent's
completion notification.

## Step 4. Verdict

The subagent's report is not a source: read the verdict from the PR. Posting the verdict is the
last step of the skill, and it does not always arrive (#154).

```bash
gh pr view <PR> --json headRefOid -q '.headRefOid[0:7]'
gh pr view <PR> --json comments -q '[.comments[] | select(.body | test("<!-- pr-(deep-review|light-check) "))] | last | .body'
```

Only a comment whose marker has `head=` equal to the current head counts. There is none → stop
(step 7) and say that the verdict was not posted in the PR. Do not retell or fill in the review
yourself.

## Step 5. Owner comments

The owner can write in the PR at any time, on a par with the reviewer. Reread the PR after every
review and before the merge question. There are three feeds, and none contains the other two:

```bash
gh pr view <PR> --json comments -q '.comments[] | {createdAt, url, body}'
gh pr view <PR> --json reviews -q '.reviews[] | select(.body != "") | {submittedAt, state, body}'
gh api --paginate repos/{owner}/{repo}/pulls/<PR>/comments -q '.[] | {id, created_at, path, line, in_reply_to_id, body}'
```

The agent and the owner post from one account, so the author cannot be told by login. An owner
comment is one that has neither the signature prefix `_🤖` nor the marker `<!-- pr-`. Matching
the whole signature does not work: it exists in two forms, the old Russian one and the new
English one, and they share only the prefix. New means later than the last one taken into
account: keep the time of the last one taken into account in the session.

An owner comment weighs no less than a `should-fix` finding: it is fixed under any reviewer
verdict, and the fix for it goes to review even if the reviewer gave APPROVE. You disagree, or it
is unclear what the owner wants — ask, do not guess.

Answer every comment taken into account in the PR: what was done and in which commit. Otherwise
the owner does not see that it was read. A plain comment —
`gh pr comment <PR> --body-file <file>`, an inline one — a reply in its thread:
`gh api repos/{owner}/{repo}/pulls/<PR>/comments/<id>/replies -F body=@<file>`.
The file lies outside the repository, and the text ends with the signature from `CLAUDE.md`,
"Agent signature on GitHub".

## Step 6. Decision after a round

| State after round `R` | `R` < 3 | `R` = 3 |
| --- | --- | --- |
| New owner comments | fix | fix |
| REQUEST_CHANGES | fix | stop |
| BLOCKED | stop | stop |
| APPROVE with a merge condition | stop | stop |
| APPROVE with a `nit` or `question` | step 7 | step 7 |
| APPROVE without findings | step 7 | step 7 |

The rows are checked top down, the first match wins.

After an APPROVE, nits and questions are not fixed without asking, in any round: whether a nit is
worth another round is the owner's call, and step 7 puts it to them with the price of each answer.

**Fix** means fix everything:
- every `blocker`, `should-fix` and `nit`;
- red brought in by the PR;
- an unmet issue criterion;
- changes the issue did not ask for;
- a `question`, if a change to code or text resolves it.

You disagree with a finding, or a `question` can be answered only in words — **stop**: put the
finding and your position to the owner and wait for the decision. That does not use up a round.
After an APPROVE that stop is step 7 itself: the finding and your position go into its report.
A reply in the PR instead of a fix does not close the round: the next run counts findings over
the cumulative diff and returns them word for word.

Fixes go out like this: `make check`, a commit "Review fixes: …", push, a mutation run if one is
needed (step 2), the run record in the PR, `R` + 1, step 3. If `R` is already 3 but an owner
comment needs a fix — step 3 all the same.

The three-round limit guards against ping-pong between author and reviewer, so you do not get
around it. A fourth round happens only on an owner comment or on the owner's "Fix the nits" in
step 7. But on run `K >= 3` the review skills themselves turn a REQUEST_CHANGES over findings into
BLOCKED. Then — stop, not a new round.

## Step 7. "Can it be merged?"

First a report to the owner: the PR, the number of rounds, the last verdict, the unfixed nits and
questions word for word, each with its `file:line`, and your position on those you disagree with
or can answer only in words. When stopping — also the reason: what exactly needs deciding.

Any question to the owner after the PR is opened — here, at a stop in step 6, on a disagreement
with a finding — comes with the full links to the PR and the issue next to it, in the report
right above the question. The owner goes to the PR to answer and should not have to look it up
by number.

After an APPROVE — AskUserQuestion "Can PR #<PR> be merged?", worded in the session's language.
Do not merge before the answer: only the owner's answer allows a merge, a clean reviewer verdict
does not. Without findings the options are "Merge" and "Left comments in the PR". With a `nit` or
`question` there are four, and the description of each says what it costs, so that the owner
chooses knowing the price:

- "Fix the nits" — one more review round now;
- "Merge, nits into an issue" — a full pipeline later (a session, `make check`, a mutation run, a
  new series of review rounds, which finds nits in the new text), if the issue is taken at all;
- "Merge" — nothing: the nits are dropped;
- "Left comments in the PR" — as many rounds as the comments need.

AskUserQuestion takes at most four options, so a new kind of answer replaces one of these rather
than joining them.

- **Fix the nits** → fix every nit and every question a change resolves, and send the fixes out as
  step 6 says: the commit, the push, the mutation run if needed, `R` + 1, step 3. At `R` = 3 this
  is a fourth round, and you open it rather than refuse: the limit guards against ping-pong
  between author and reviewer, not against the owner, and this answer is the same kind of
  decision as an owner comment.
- **Left comments** → step 5, fixes, step 3.
- **Merge** and **Merge, nits into an issue** → step 5 once more: the owner may have written in the
  PR while thinking. There are new comments — name them and ask again. None:

  ```bash
  gh pr view <PR> --json mergeable,mergeStateStatus
  ```

  A conflict — merge `origin/main` into the branch, resolve it, `make check`, push, a mutation run
  if one is needed (step 2), the run record in the PR. The head changed, so a new review round
  is needed (step 3), then this step again. No conflict:

  ```bash
  gh pr merge <PR> --merge
  ```

  Exactly `--merge`, not squash: `make worktree-cleanup` checks that the branch is an ancestor of
  `main` on origin and refuses after a squash.

  After "Merge, nits into an issue" — file an issue as `docs/agents/issue-tracker.md` says: every
  unfixed nit and question quoted word for word, each with its lines as they stand in `main` after
  the merge (`git fetch origin`, then `git show origin/main:<path>`), and links to the PR and to
  its verdict comment. The review numbered the lines against the PR head, and a merge commit
  shifts them when `main` changed the same file in the meantime. The report of step 8 names the
  new issue. After "Merge" the nits are dropped, and the report of step 8 names them as dropped.

## Step 8. Cleanup

After the merge, in the task worktree — `make worktree-cleanup`. It removes the worktree and
fast-forwards `main` in the main worktree, so return there afterwards and do not switch the
branch in it: a neighbouring session may be working there. The output says `main` was not
fast-forwarded — name that in the report together with the hint from the output: switching the
branch in the main worktree is not allowed, and while `main` lags behind, the next session reads
the pre-merge code there. A non-zero exit code with a message about the branch — the local one
could not be deleted, the one on `origin` could not be deleted, or `origin` could not be asked
whether it is there — is not a failed cleanup: the worktree is already removed, there is nowhere
to repeat the target from, and the branch named in the message and the hint from the output go
into the report. A message about the worktree itself is the opposite, a failure: the cleanup
stopped on removing it, and the hint says whether to repeat the target from the task worktree or
to finish the cleanup with the commands it names.

Check `gh issue view <N> --json state`. The issue did not close — close it by hand as
`docs/agents/issue-tracker.md` says.
