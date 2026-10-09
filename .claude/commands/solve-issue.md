---
description: Solve an issue end to end — implementation, PR, rounds of agent review and a merge on the owner's answer
argument-hint: <issue number or link>
---

You are the author. Arguments: `$ARGUMENTS`.

Your job is to bring the issue to a PR that has passed review and to ask the owner whether it
can be merged. You implement and fix it yourself. A fresh subagent reviews it with the
`/review-pr` command. The owner decides on the merge.

Fix the reviewer's findings. When you disagree with one, ask the owner (step 6) instead of quietly
overruling it. The reviewer is a separate agent on purpose. A review in the author's session sees
the diff through the author's eyes: it knows why every line is the way it is. It sees neither the
knowledge the diff lost nor the false statements it left.

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
`docs/architecture/`, `docs/architecture/invariants.md`.

It is unclear what exactly is asked, or there is a fork the owner decides — ask through
AskUserQuestion and wait for the answer. A guessed answer turns into a review round over an unmet
criterion.

The issue turns out bigger than one PR a review can take in — the same stop: propose a split into
stages, each a PR of its own, and wait. The sign is parts that could each be merged alone. Delivered
whole, such a PR can be closed as unmaintainable, and the work is redone in stages anyway (PR #551).

Then the "Workflow" of `CLAUDE.md`, with no exceptions:

1. Choose the branch prefix before the first push: renaming the branch of an open PR closes it.
2. The worktree `<main>-<task>` next to the main worktree, where `<main>` is the name of its
   directory, from `origin/main`; `make worktree-init` in it. Right before `git worktree add`,
   look for a neighbour who took the same issue:

   ```bash
   { git worktree list --porcelain | grep -E '^(worktree|branch) '; git ls-remote --heads origin | cut -f2; } | /usr/bin/grep -E '[^0-9]<N>([^0-9]|$)'
   ```

   The last `grep` is `/usr/bin/grep`: in the Claude Code shell `grep` is a function from the
   session snapshot, and it drops the matches of `([^0-9]|$)`, so the check passes falsely.

   A printed line → do not create the worktree: stop and ask the owner. A session that took
   the issue minutes ago has no PR yet, so step 1 does not see it: its only traces are a local
   worktree and branch, and on GitHub not even the branch until its first push. The check runs
   here and not only in step 1 because a neighbour can claim the issue in between, while the
   owner answers a question. It narrows the window and does not close it.
3. Edits, `make check`, `git status -sb`, commit, push.
4. A PR into `main` with the issue link; how to write it is in `docs/agents/issue-tracker.md`.
   Without the link the review gives BLOCKED. Right after the PR, record the issue in a batch if
   the change turned on `mutation-full` (below).

All further commands run in the task worktree.

### The batch of the deferred mutation run

Neither you nor the reviewer runs `make mutation`. The change turned on the `mutation-full` gate
(`docs/agents/review-gates.md`) — record the issue in a batch of the deferred mutation run once the
PR exists, after the push that turned the gate on:

```bash
make mutation-full-record issue=<N> pr=<PR>
```

A repeat call records nothing twice. Without the record the review gives red: it checks the batch,
not a run. A weak test the PR brings shows only in the batch run, and its survivors are fixed by
the session of the batch, not by you.

### A batch as the issue

An issue `Full mutation run <M>` that reached its threshold is taken with this command too. Its task
is the run itself:

1. The worktree as above, from fresh `origin/main`. `make mutation batch=<M>` on a clean tree: it
   runs over the files `make mutation-batch-files batch=<M>` prints, or over the whole of `src/`
   when that names a PR that changed a tool of the run or finds no file left. A full run takes
   hours. Its record is kept in `reports/mutation/batch-record.md`, and that is the input of the
   close.
2. The run is red — fix the survivors you can in the same worktree and commit. The survivors left
   go into one issue per area, each filed on the owner's go-ahead on its text (`CLAUDE.md`,
   "Scope"), and are silenced by a mark linking to it (`docs/architecture/testing.md`, "Working
   through survivors"). Then check the fixes with
   `make mutation files="<the source files of the survivors>"` on the clean tree, not with a second
   batch run: the owner's decision (2026-10-03). That run left survivors of its own — fix them,
   commit, and run again over the source files whose survivors this round fixed or whose specs it
   changed: the files of the earlier rounds have their run already. A file of an earlier round that
   shares a spec helper this round changed is not run again, and the next batch reaches it only when
   a PR it records changes that file in code (`docs/agents/review-gates.md`, the paragraph on
   `mutation-full`). The fixes are done when the run of the last round is green.
3. In the worktree of the runs:

   ```bash
   make mutation-full-close batch=<M> issues="<N> …"
   ```

   `issues` names the issues of item 2 and is left out when there are none. The target carries the
   recorded PRs the batch run did not cover into the next batch and posts the closing comment with
   the record of the batch run and of the run over files. What it checks before a write is in the
   docstring of `scripts/review/mutation_batch.py`.
4. Fixes were committed — a PR with `Closes #<M>`: the workflow list of step 2 goes on from its
   item 3. The batch is closed by then, so `make mutation-full-record` puts the PR into the next
   one. No fixes — no PR: the report to the owner, then `make worktree-cleanup`.

## Step 3. Review

### Before the round: `origin/main`

Before every round, the first one included, check whether `main` has moved under the PR in a way
the round should see. From the root of the task worktree:

```bash
git fetch origin
git merge-tree --write-tree HEAD origin/main >/dev/null; echo $?
git diff --no-renames --name-only HEAD...origin/main -- $(git diff --no-renames --name-only origin/main...HEAD)
```

`merge-tree` exits with 1 on a conflict and with 0 on a clean merge. The last command prints the
files of the PR diff that `main` changed since the branch's merge-base.

- A conflict, or at least one file printed — `git merge origin/main`, resolve, `make check`, push.
  Then the round.
- Otherwise the round opens without a merge.

A merge on every round would cost a `make check` and a push per round, and with neighbouring
sessions moving `main` often they buy nothing when `main` changed unrelated files. The check does
not catch `main` changing a file the PR depends on without changing the PR's own files (a shared
spec helper, an imported module): with no CI, nothing checks that combination.

### The round

Count the rounds yourself: `R` = 1, 2, 3. Every round is a new subagent: the Agent tool,
`subagent_type: general-purpose`. The prompt is exactly this and nothing more:

> Run the `review-pr` skill with the argument `<PR>`. When done, print on one line: the verdict,
> the run number, the head.

Add no description of the implementation, no "what to pay attention to", none of your past
answers to findings. Any of it gives the review the author's eyes back. Wait for the subagent's
completion notification.

## Step 4. Verdict

Read the verdict from the PR: the subagent's report is not a source. Posting the verdict is the
last step of the skill, and it does not always arrive (#154).

```bash
gh pr view <PR> --json headRefOid -q '.headRefOid[0:7]'
gh pr view <PR> --json comments -q '[.comments[] | select(.body | test("<!-- pr-(deep-review|light-check) "))] | last | .body'
```

Only a comment whose marker has `head=` equal to the current head counts. There is none → stop
(step 7) and say that the verdict was not posted in the PR. Do not retell the review or fill it in
yourself.

## Step 5. Owner comments

The owner can write in the PR at any time, on a par with the reviewer. Reread the PR after every
review and before the merge question. There are three feeds, and none contains the other two:

```bash
gh pr view <PR> --json comments -q '.comments[] | {createdAt, url, body}'
gh pr view <PR> --json reviews -q '.reviews[] | select(.body != "") | {submittedAt, state, body}'
gh api --paginate repos/{owner}/{repo}/pulls/<PR>/comments -q '.[] | {id, created_at, path, line, in_reply_to_id, body}'
```

An owner comment has neither the signature prefix `_🤖` nor the marker `<!-- pr-`.

- The login does not tell the author: the agent and the owner post from one account.
- Match the prefix, not the whole signature. The signature exists in two forms, the old Russian
  one and the new English one, and they share only the prefix.
- A comment is new when it is later than the last one taken into account. Keep the time of that
  one in the session.

An owner comment weighs no less than a `should-fix` finding:

- it is fixed under any reviewer verdict;
- the fix for it goes to review even if the reviewer gave APPROVE;
- you disagree, or it is unclear what the owner wants — ask, do not guess.

Answer in the PR every comment taken into account: what was done and in which commit. Otherwise
the owner does not see that it was read.

- A plain comment: `gh pr comment <PR> --body-file <file>`.
- An inline one: a reply in its thread,
  `gh api repos/{owner}/{repo}/pulls/<PR>/comments/<id>/replies -F body=@<file>`.
- The file lies outside the repository. The text ends with the signature from `CLAUDE.md`,
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

After an APPROVE, nits and questions are not fixed without asking, in any round. Whether a nit is
worth another round is the owner's call, and step 7 puts it to them with the price of each answer.

**Fix** means fix everything:
- every `blocker`, `should-fix` and `nit`;
- red brought in by the PR;
- an unmet issue criterion;
- changes the issue did not ask for;
- a `question`, if a change to code or text resolves it.

You disagree with a finding, or a `question` can be answered only in words — **stop**. Put the
finding and your position to the owner and wait for the decision.

- The stop does not use up a round.
- After an APPROVE that stop is step 7 itself: the finding and your position go into its report.
- A reply in the PR instead of a fix does not close the round: the next run counts findings over
  the cumulative diff and returns them word for word.

Fixes go out in this order: `make check`, a commit "Review fixes: …", push, the batch record if
the fixes turned `mutation-full` on (step 2), `R` + 1, step 3. At `R` = 3 an owner comment that
needs a fix still goes to step 3.

Do not get around the three-round limit: it guards against ping-pong between author and reviewer.
A fourth round happens only on an owner comment or on the owner's "Fix the nits" in step 7. On run
`K >= 3`, though, the review skills themselves turn a REQUEST_CHANGES over findings into BLOCKED.
Then stop: it is not a new round.

## Step 7. "Can it be merged?"

First a report to the owner, as visible text before the question. An APPROVE without findings
needs it too: a summary left in the reasoning never reaches the owner.

- the PR, the number of rounds, the last verdict;
- the unfixed nits and questions word for word, each with its `file:line`;
- your position on those you disagree with or can answer only in words;
- when stopping, the reason: what exactly needs deciding.

Any AskUserQuestion to the owner after the PR is opened carries the full links to the PR and the
issue in its question text, not only in the report: "Can PR #<PR> be merged? PR: <PR URL> ·
issue: <issue URL>". That holds here, at a stop in step 6 and on a disagreement with a finding.
The owner goes to the PR to answer and should not have to look it up by number. The question is
the one part that always reaches the owner: a report that was skipped takes its links with it.

After an APPROVE — AskUserQuestion "Can PR #<PR> be merged?" with the links, worded in the
session's language.
Do not merge before the answer: only the owner's answer allows a merge, a clean reviewer verdict
does not.

Without findings the options are "Merge" and "Left comments in the PR". With a `nit` or
`question` there are four. The description of each says what it costs, so that the owner chooses
knowing the price:

- "Fix the nits" — one more review round now;
- "Merge, nits into an issue" — a full pipeline later (a session, `make check`, a new series of
  review rounds, which finds nits in the new text), if the issue is taken at all;
- "Merge" — nothing: the nits are dropped;
- "Left comments in the PR" — as many rounds as the comments need.

AskUserQuestion takes at most four options, so a new kind of answer replaces one of these rather
than joining them.

- **Fix the nits** → fix every nit and every question a change resolves. Send the fixes out as
  step 6 says: the commit, the push, the batch record if needed, `R` + 1, step 3. At `R` = 3 this
  is a fourth round: open it, do not refuse. The limit guards against ping-pong between author and
  reviewer, not against the owner, and this answer is a decision of the same kind as an owner
  comment.
- **Left comments** → step 5, fixes, step 3.
- **Merge** and **Merge, nits into an issue** → step 5 once more: the owner may have written in the
  PR while thinking. There are new comments — name them and ask again. None:

  ```bash
  gh pr view <PR> --json mergeable,mergeStateStatus
  ```

  A conflict — step 3: its check before the round merges `origin/main`, and the moved head needs
  a new review round. Then this step again. No conflict:

  ```bash
  gh pr merge <PR> --merge
  ```

  Exactly `--merge`, not squash: `make worktree-cleanup` checks that the branch is an ancestor of
  `main` on origin and refuses after a squash.

  After "Merge, nits into an issue" — file an issue as `docs/agents/issue-tracker.md` says. It
  carries:

  - every unfixed nit and question, quoted word for word;
  - for each, its lines as they stand in `main` after the merge (`git fetch origin`, then
    `git show origin/main:<path>`). The review numbered the lines against the PR head, and a merge
    commit shifts them when `main` changed the same file in the meantime;
  - links to the PR and to its verdict comment.

  The report of step 8 names the new issue. After "Merge" the nits are dropped, and the report of
  step 8 names them as dropped.

## Step 8. Cleanup

After the merge, run `make worktree-cleanup` in the task worktree. It removes the worktree and
fast-forwards `main` in the main worktree. Return to the main worktree afterwards and do not
switch the branch in it: a neighbouring session may be working there.

Read the output:

- `main` was not fast-forwarded — name that in the report, with the hint from the output.
  Switching the branch in the main worktree is not allowed. While `main` lags behind, the next
  session reads the pre-merge code there.
- A non-zero exit code with a message about the branch is not a failed cleanup. The message says
  the local branch could not be deleted, the one on `origin` could not be deleted, or `origin`
  could not be asked whether it is there. The worktree is already removed, so there is nowhere to
  repeat the target from. The branch named in the message and the hint from the output go into
  the report.
- A message about the worktree itself is a failure: the cleanup stopped on removing it. The hint
  says whether to repeat the target from the task worktree or to finish the cleanup with the
  commands it names.

Check `gh issue view <N> --json state`. The issue did not close — close it by hand as
`docs/agents/issue-tracker.md` says. Its rule on parent issues decides both whether an issue with
open sub-issues stays open and whether the parent of `N` closes now.
