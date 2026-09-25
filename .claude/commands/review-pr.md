---
description: Pull Request review — reads the diff and runs the check of the right depth
argument-hint: <PR number> [--comment] [--no-post]
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*), Read, Skill
---

You are the review router. Arguments: `$ARGUMENTS`.

Your job is to find out what changed in the PR and run one skill of the right depth. You
check nothing yourself: you do not read the code, run commands or give a verdict. All the
routing lives here; the skills are executors and have no routing of their own.

## Step 1. PR

The first argument is the PR number. None given → find the PR of the current branch:
`gh pr view --json number,title`. No PR found — stop and say so.

## Step 2. Diff

```bash
gh pr diff <N> --name-only
```

The list is empty → say the diff is empty and stop.

## Step 3. Depth

| The diff has | Skill |
| --- | --- |
| at least one `.ts`, `.sh` or `.py` | `pr-deep-review` |
| anything else | `pr-light-check` |

`.ts`, `.sh` and `.py` are the only signs of depth. A change to the `Makefile`, `tsconfig.json`,
`package.json`, a compose file or the documentation does not by itself call for a full review:
architecture invariants, smells and bug hunting have nothing to find there, and they cost a lot.
`.py` is executable code like the other two: the actions of the review skills
(`scripts/review/`) drive `git` and `docker` on the host, and `pr-light-check` has no bug hunt
and no search for the documentation a change made false. PR #559 had no `.ts` or `.sh`, passed the
light check twice and was merged with a bug: no bug hunt ran on it.

The boundary is drawn by price, not by importance. **Both** skills check issue compliance: it
is not a sign of depth but a condition of any verdict. A green run on a PR that touches only the
`Makefile` means only that nothing failed, not that what was asked for is done.

## Step 4. Gates

Work out by the gate table (`docs/agents/review-gates.md`) which gates are on, and pass them to
the skill as a list. The table and the reasoning behind its rows live there and not here,
because routing is not its only user: the author and the reviewer apply the same table to a
different diff to decide whether a mutation run record is stale. Here it is applied to the diff
of step 2, and only here does it choose the gates that go to the skill.

## Step 5. Launch

Call the chosen skill and pass it three things: the PR number, the list of gates that are on,
and the flags from `$ARGUMENTS` (`--comment`, `--no-post`).

The skill does the rest: the run, issue compliance, the verdict, the PR comment. Add no text of
your own on top of its verdict and do not retell it: it has already printed its report to the
session.
