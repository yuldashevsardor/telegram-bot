A batch of the deferred full mutation run.

A change to the tools of the mutation run turns on the `mutation-full` gate
(`docs/agents/review-gates.md`). Instead of a full `make mutation` on every review round, the
change is recorded here: every comment that starts with the marker `<!-- mutation-batch-record`
names an issue and its PR. `make mutation-full-record` writes the records; see the docstring of
`scripts/review/mutation_batch.py`.

At {threshold} recorded issues the batch is due: a full `make mutation` on fresh `main`, the
survivors fixed in the same task, the result in the closing comment.

_🤖 Posted by Claude Code from the owner's account._
