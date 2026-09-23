# Domain docs

How agent skills read this repository's documentation. The layout is single-context: one
glossary, `CONTEXT.md` at the root.

Before starting, read `CONTEXT.md` (the domain terms), the file of the affected subsystem in
`docs/architecture/` (structure and runtime) and the ADRs of the area you are changing. Which
document to read for which task is routed by the documentation section of `CLAUDE.md`.

ADRs live in `docs/adr/`. The directory does not exist yet: it is created with the first
decision that is hard to roll back; ADRs are not written after the fact, and the missing
directory is not to be reported. Once it exists, a conclusion that contradicts an ADR is said
out loud ("Contradicts ADR-0007, but worth reopening because…"), not rewritten silently.

Name a domain concept (an issue title, a test name, a refactoring proposal) with the term
from `CONTEXT.md`, not a synonym. A concept missing from the glossary means either you are
inventing language the project does not have, or it is a gap for `domain-modeling`.
