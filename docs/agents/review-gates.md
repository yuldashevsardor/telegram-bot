# Review gates

The table that turns the changed files into a list of checks. The `/review-pr` command
(step 4) applies it to the PR diff and passes the gates that are on to the review skill.

The author applies it too: whether the change turned on `mutation-full`, and the issue goes into a
batch of the full mutation run (`/solve-issue`, step 2). That is why the table is a document of its
own and not part of the routing: two parties apply it, and with one copy nothing can drift apart.
The author picks neither a skill nor the run's gates by it: that is still done by `/review-pr`
alone.

## The table

Gates accumulate: one file can turn on several, and a diff usually falls into several rows at
once.

| Changed in the diff | Turns on |
| --- | --- |
| `package.json`, `package-lock.json`, `Dockerfile`, `.eslintrc.js`, `.prettierrc.js`, `.mocharc.json` | `rebuild` |
| any `.ts`, `tsconfig.json`, `tsconfig.check.json`, an eslint or prettier config | `build`, `typecheck`, `lint`, `format-check` |
| any `.ts`, `test/**`, `.mocharc.json` | `test` |
| `Makefile` | `make-targets` |
| `scripts/*.sh`, `.husky/*` | `scripts` |
| `scripts/**/*.py` | `python` |
| any `.sh` or `.py`; any `.ts` — not a comments-only `.ts` diff | `docs-sync` |
| any `.ts` — not a comments-only `.ts` diff | `bug-hunt-high` |
| `.sh` or `.py`, and either no `.ts` or only a comments-only `.ts` diff | `bug-hunt-medium` |
| `.ts` inside `src/font-convertor/`, `src/shared/`, `src/telegram/outbound-queue/`, `src/telegram/outbox/`, `src/telegram/bot-api-failure-classifier/` — not a comments-only `.ts` diff | `smells` |
| any `.ts` — a comments-only `.ts` diff | `comments` |
| `stryker.config.mjs`, `test/stryker-mocha-hook.cjs`, `test/mutation-record.ts`, `.mocharc.json`, `tsconfig.json`, `tsconfig.check.json` — not a comments-only diff; any `.ts` in `src/` or `test/` — not a comments-only `.ts` diff | `mutation-full` |
| any `*.md`, including `docs/**` and `.claude/**` | `docs` |

`build` and `typecheck` go on together, and neither replaces the other. The targets use
different tsconfigs, and `typecheck` covers a wider set of files: what is added to it and why
is said in a comment in `tsconfig.check.json`. Without `typecheck`, a PR that changes only
specs would not be type-checked at all: `mocha` loads them through `tsx`, and `tsx` does not
check types (`docs/architecture/testing.md`).

`package.json` turns on `rebuild` on any change, as in the table. The file lives in the image
rather than being mounted, and an old image would check the old dependencies, scripts and
`nyc` config. Its other gates are decided by the content of the change, not by the name. Read
the file's diff:

- the `scripts` block touched — `make-targets` too;
- the `nyc` key touched — `test` too: the config and the coverage threshold the gate checks
  live there;
- the `mutation` script, the `@stryker-mutator/*` dependencies or `typescript` touched —
  `mutation-full` too.

The same for `package-lock.json`: the version of `typescript` or `@stryker-mutator/*` changed —
`mutation-full` too, even when `package.json` is untouched (`npm update` within the range).

A new version of a runtime dependency does not turn on `mutation-full`. That is a decision
about price, not an oversight. The dependencies' types go into the checker's compilation and
decide who gets `CompileError` (`docs/architecture/testing.md`, "The type checker"). Say a
grammY update made the `from` field required: the mutant `ctx.from?.language_code` in
`src/telegram/locale/locale.ts` would start to compile, reach the tests and survive. It would
turn red in the next batch run, which mutates the whole of `src/` on a `main` that has the update.
The owner (2026-09-21) chose to catch such a survivor later: a full run then cost 15+ minutes per
review round, and paying that for every dependency update cost more.

The `Makefile` is not written into the `mutation-full` row by name. `make up`, `make logs` and
the other targets do not touch the run, and by file name any change to them would take a place in
a batch of the full run (below) for nothing. Decide by the content of the change, as with
`package.json`, and read the file's diff: the recipe of the `mutation` target or a variable it
expands (`DC_APP_RUN`, `FILES`) touched — `mutation-full` too. The recipe is the launch. It sets
`TSX_TSCONFIG_PATH=./tsconfig.check.json`, by which the type checker decides which mutant gets
`CompileError`. It sets `MUTATE` from `files`. It holds the wrapper command itself,
`node --require tsx/cjs test/mutation-record.ts`. Changing any of them changes the outcome of
every mutant: the same argument that puts the tsconfigs in the row.

A comments-only diff of the files in the `mutation-full` row leaves the gate off. Read the
diff, as with `package.json` and the `Makefile` above. A comment is neither an option the
runner reads nor an input of the type checker. None of these files is mutated either: `mutate`
in `stryker.config.mjs` admits only globs that hit a `.ts` under `src/`, and checks that. So a
comment changes the outcome of no mutant, while the gate takes a place in a batch of the full
run. The gate still goes on for:

- a changed option, path, glob, argument or string literal;
- a hunk that touches a comment and code on the same line;
- a comment that is a tool directive: `// @ts-expect-error`, `// eslint-disable` and
  `// Stryker disable` are inputs, not text.

Comments only is a statement about the content of the diff, not about lines that look like
comments. `.mocharc.json` and both tsconfigs are JSONC, and `"spec": "test/**/*.spec.ts"`
carries `**` inside a string literal, so a grep for `//` or `*` decides nothing.

A comments-only `.ts` diff turns off `bug-hunt-high`, `smells`, `docs-sync` and the `.ts` part of
`mutation-full`, and turns on `comments` instead. Read the diff, as with the tools of the
`mutation-full` row. The `.ts` diff is every `.ts` of the PR taken together: one changed line of
code in any `.ts`, and every row goes by name, with the full review for the whole PR. A `.ts` that
is added, deleted, renamed, copied or changes mode is code too, whatever its hunks hold, and a
rename has no hunks. Renaming a migration breaks the append-only rule that only the full review
checks. Renaming `test/x.spec.ts` to `test/x.ts` drops its specs from the `.mocharc.json` glob while
`test` stays green.

The bug hunt and the smells look at what the code does, and a comment changes nothing it does.
PRs #522, #523 and #524 changed comments in `.ts` and `*.md`: three rounds of the full review
each, 5–6.5M tokens of review subagents per PR. Of the findings in their nine verdicts none
concerned behaviour, and all but one set the text of a comment, a doc or the PR body against
the code. That is the check `comments` turns on (`.claude/skills/pr-light-check/SKILL.md`,
step 3). Unlike a paragraph of `docs/`, a comment has the code it describes a few lines away,
so checking it against the code costs little.

`docs-sync` goes off too: it looks for documentation made false by a changed symbol, and a
comment changes no symbol. Round 3 of #522 found, outside the diff, the statement the PR
corrected still stale in the `.eslintrc.js` comment and in `docs/architecture/logging.md`.
That is the same claim in another place, and `comments` looks for it with the duplicate
search.

Comments only is read as for the tools of the `mutation-full` row: by the content of the diff, not
by lines that look like comments. `//` inside a string or a template literal is not a comment. A
hunk that changes a comment and code on the same line is code. A tool directive is code too, and
`.ts` has more of them than the run's tools do: `// Stryker disable …`, `// Stryker restore …`,
`// eslint-disable…`, `// @ts-expect-error`, `// @ts-ignore`, `/* istanbul ignore … */`,
`// prettier-ignore`, `/// <reference … />`. A directive is a comment any line of which opens
with `///`, with `@` or with the name of a tool (Stryker, eslint, istanbul, prettier) past the
comment marks: TypeScript reads `@ts-ignore` on the last line of a block comment too. Each is read
by a gate, so a diff that touches one gets the full review. So does a comment that changes which
line a directive covers: its line break moves code off that line, or a comment between the
directive and its code changes (the paragraph on `mutation-full` below).
`scripts/review/mutation_area.py` holds the same rule as code (`is_directive`), and its specs check
it against this list.

The gates that run the code stay on by name. `build`, `typecheck`, `lint`, `format-check` and
`test` take seconds, and a directive the reading missed still changes their outcome. A `.sh` is
not read this way: a comment there can be a shebang or a linter directive, and its comments-only
diffs were not measured.

`mutation-full` runs code too, in the batch run, yet goes off: its price is not seconds but a place
in a batch of the full run. And the status of a mutant changes only through a directive: the mark
that silences a survivor (`docs/architecture/testing.md`, "Working through survivors"), which acts
only in a mutated file, and the `@ts-` comments of a source or a spec, by which the type checker
decides who gets `CompileError` ("The type checker" there). A directive acts by line, and a comment
reaches a status through it when its line break moves code off the line the directive covers:
`// Stryker disable next-line` over a `for` header no longer reaches the `<` a comment pushed onto
the next line. Such a diff is not comments only.

`bug-hunt-*` and `smells` are kept apart on purpose, and their boundaries differ. Bugs are
hunted wherever there is executable code. In `src/platform/`, `src/bootstrap/` and
`src/telegram/` they cost more than in the domain, because they fail at runtime in front of
the user. In the shell scripts and the Python actions of the review skills (`scripts/review/`)
they break the host tooling: a worktree, the shared database, a review round. Fowler's smells
make sense only on code that expresses the domain. An adapter around grammY is a Middle Man by
nature, `container.ts` is Divergent Change, and migrations are Duplicated Code that cannot be
rewritten, since they are append-only. On such a diff the Standards axis yields remarks bound
to be rejected, at the cost of a full run.

The sign of `smells` is "the code expresses rules rather than serving someone else's API", but
the gate is decided by directory. `/review-pr` reads a diff only for signs a reading settles,
such as a key of `package.json` or a comment against a line of code. Whether code expresses
rules is a judgement, not such a sign. That is why `src/telegram/outbound-queue/`,
`src/telegram/outbox/` and `src/telegram/bot-api-failure-classifier/` are in the list while the
rest of `src/telegram/` is not: they hold the algorithm of the queue and of the outbox and the
rules of which failed call is which class, not a wrapper around grammY. The list is an allowlist
on purpose, and that has a price: a new or moved module with rules drops out of the gate silently
until it is written in here. The PR that creates or moves the module writes it in.

The level is built into the gate's name: the skill calls the built-in `code-review` with it.
`bug-hunt-high` and `bug-hunt-medium` are a pair of rows that does not accumulate: there is
one run, and it has one level. On a diff made only of bash scripts, the wider coverage of
`high` brings uncertain findings and extra cost, not bugs. The Python of this repository is
the same kind of code: host tooling that drives `git`, `gh` and `docker` from outside the
containers (`docs/architecture/testing.md`), not the domain. So a `.py` takes the level of the
scripts, and a diff with `.py` and `.ts` together goes at `high` by its `.ts`.

The level is decided by the table and not by the skill. The sign "there is a `.ts` that is not
comments only" is already computed by the choice of depth (`/review-pr`, step 3). A second copy
of it would drift from this one silently: both files would still read coherently, and the
boundary would move in only one of them.

`mutation-full` is turned on by a change of code and by a change of the run's tools. Changing the
tools changes the run of every mutant, not of the diff's lines. The tsconfigs and `typescript` are
tools too: by them the type checker decides which mutant gets `CompileError` and which goes to the
tests (`docs/architecture/testing.md`, "The type checker"). The gate runs no mutants in the PR:
neither the author nor the reviewer runs `make mutation`. The issue the PR closes is recorded in a
batch instead, and the whole of `src/` runs on fresh `main` once per batch. The author records it
after the PR is created (`make mutation-full-record issue=<M> pr=<N>`), and the review checks the
record (`make mutation-full-check pr=<N>`): an issue that is not recorded is red. How a batch is
kept is in the docstring of `scripts/review/mutation_batch.py`.

A run of the PR's own area went until #712, and the owner (2026-09-30) dropped it for its price. It
was paid on every review round, and parallel sessions on one machine slow each other down 3–8×: on
2026-09-29 four area runs overlapped and took 16–32 minutes, while the same areas took 4–9 on an
idle machine, and PR #693 ran its area 8 times, about two hours in total. A batch run is paid once,
by one session, and it reaches what an area run missed by construction: `container.ts` and
`tokens.ts`, which the area left to the full run, and a helper `main` changed under the area.

The accepted cost: a weak test is found only by the batch run, possibly weeks after the PR that
brought it, and its survivors are fixed by the session of the batch, not by the PR's author. A PR
that breaks the run itself (a Stryker update, say) shows that only in the batch run too.

With the `rebuild` gate on, the image is rebuilt **before** the other checks. Otherwise new
code is checked against old dependencies and an old config, and a green result means nothing.

`docs` and `docs-sync` look at documentation drift from two sides, so different files turn
them on. `docs` is for a text change: the changed lines of `*.md` are checked. `docs-sync` is
for a code change: the documentation the PR did not touch is checked. `docs` turns on no run,
so a documentation-only diff still gets by without the database and containers.
