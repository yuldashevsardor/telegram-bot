# Issue tracker: GitHub

Tasks live in GitHub Issues and are handled through the `gh` CLI. "Publish to the tracker"
means filing an issue; the work on it goes in its own branch and PR, see the workflow section
of `CLAUDE.md`.

- A multi-line body goes through `--body-file <file>`, not `--body`: in an argument the shell
  runs the backticks and expands `$…`, and the bodies here are full of identifiers in
  backticks.
- The auto-close keyword in a PR body is `Closes #N`. GitHub recognises only its own keywords
  (`Closes`, `Fixes`, `Resolves` and their forms); any other wording, a translation included,
  closes nothing — the issue stays open after the merge and has to be closed by hand.
- When closing an issue by hand, leave a comment with the outcome: what was merged and what
  exactly settled the question.
- No new labels: the stock ones are enough (`gh label list`). The triage machine of the
  `triage` skill and its labels (`needs-triage` and the like) are not used, and
  `docs/agents/triage-labels.md` is absent on purpose.
- A bare `#42` can be either an issue or a PR: first `gh pr view 42`, on failure
  `gh issue view 42`.
- Everything posted to GitHub from the owner's account carries the signature from the agent
  signature section of `CLAUDE.md`.

## PRs as a request surface: no

External PRs do not enter the triage queue alongside issues. Set this to "yes" if that
changes.

## Wayfinding operations

Used by the `wayfinder` skill. The map is one issue labelled `wayfinder:map`, the tickets are
its child issues labelled `wayfinder:<type>`. The repository has no labels of this family
yet: they are created together with the first map.

A child ticket is attached to the map as a native sub-issue, blocks are native GitHub
dependencies:

```bash
gh api --method POST repos/<owner>/<repo>/issues/<map>/sub_issues -F sub_issue_id=<ticket id>
gh api --method POST repos/<owner>/<repo>/issues/<ticket>/dependencies/blocked_by -F issue_id=<blocker id>
```

Both operations take the numeric database id, not the issue number: `gh api
repos/<owner>/<repo>/issues/<n> --jq .id`; neither `#number` nor `node_id` works.
A ticket is free when all its blockers are closed.
