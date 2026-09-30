A batch of the deferred full mutation run.

A change of code, a `.ts` in `src/` or `test/` or a tool of the mutation run, turns on the
`mutation-full` gate (`docs/agents/review-gates.md`). Instead of a `make mutation` on every review
round, the change is recorded here: every comment that starts with the marker
`<!-- mutation-batch-record` names an issue and its PR. `make mutation-full-record` writes the
records; see the docstring of `scripts/review/mutation_batch.py`.

At {threshold} recorded issues the batch is due: a full `make mutation` on fresh `main`, the
survivors fixed in the same task, then `make mutation-full-close` carries the PRs the run did not
cover into the next batch and puts the result in the closing comment. How the batch is taken is in
`.claude/commands/solve-issue.md`, "A batch as the issue".

_🤖 Posted by Claude Code from the owner's account._
