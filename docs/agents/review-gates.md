# Review gates

The table that turns the changed files into a list of checks. The `/review-pr` command
(step 4) applies it to the PR diff and passes the gates that are on to the review skill.

The author applies it too: whether the change turned on `mutation-full`, and the issue goes into a
batch of the deferred mutation run (`/solve-issue`, step 2). That is why the table is a document of
its own and not part of the routing: two parties apply it, and with one copy nothing can drift
apart.
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
| `.ts` inside `src/font-convertor/`, `test/conversion/`, `test/font-convertor/convertor-factory.helper.ts` — not a comments-only `.ts` diff; `test/fixtures/fonts/**`, `Dockerfile`, `package-lock.json` | `test-fonts` |
| `Makefile` | `make-targets` |
| `scripts/*.sh`, `.husky/*` | `scripts` |
| `scripts/**/*.py` | `python` |
| any `.sh` or `.py`; any `.ts` — not a comments-only `.ts` diff | `docs-sync` |
| any `.ts` — not a comments-only `.ts` diff | `bug-hunt-high` |
| `.sh` or `.py`, and either no `.ts` or only a comments-only `.ts` diff | `bug-hunt-medium` |
| `.ts` inside `src/font-convertor/`, `src/shared/`, `src/telegram/outbox/`, `src/telegram/inbox/`, `src/telegram/retry-delay/`, `src/telegram/bot-api-failure-classifier/` — not a comments-only `.ts` diff | `smells` |
| any `.ts` — a comments-only `.ts` diff | `comments` |
| `stryker.config.mjs`, `test/stryker-mocha-hook.cjs`, `test/mutation-run.ts`, `.mocharc.json`, `tsconfig.json`, `tsconfig.check.json` — not a comments-only diff; any `.ts` in `src/` or `test/` — not a comments-only `.ts` diff | `mutation-full` |
| any `*.md`, including `docs/**` and `.claude/**` | `docs` |

With the `rebuild` gate on, the image is rebuilt **before** the other checks. Otherwise new
code is checked against old dependencies and an old config, and a green result means nothing.

`build` and `typecheck` go on together, and neither replaces the other. The targets use
different tsconfigs, and `typecheck` covers a wider set of files: what is added to it and why
is said in a comment in `tsconfig.check.json`. Without `typecheck`, a PR that changes only
specs would not be type-checked at all: `mocha` loads them through `tsx`, and `tsx` does not
check types (`docs/architecture/testing.md`).

## Rows decided by the content of a file

`package.json` turns on `rebuild` on any change, as in the table. The file lives in the image
rather than being mounted, and an old image would check the old dependencies, scripts and
`nyc` config. Its other gates are decided by the content of the change, not by the name. Read
the file's diff:

- the `scripts` block touched — `make-targets` too;
- the `nyc` key touched — `test` too: the config and the coverage threshold the gate checks
  live there;
- the `test:fonts` script touched — `test-fonts` too: it is the launch of the conversion check;
- the `mutation` script, the `@stryker-mutator/*` dependencies or `typescript` touched —
  `mutation-full` too.

The same for `package-lock.json`: the version of `typescript` or `@stryker-mutator/*` changed —
`mutation-full` too, even when `package.json` is untouched (`npm update` within the range).

A new version of a runtime dependency does not turn on `mutation-full`. That is a decision
about price, not an oversight. The dependencies' types go into the checker's compilation and
decide who gets `CompileError` (`docs/architecture/testing.md`, "The type checker"). Say a
grammY update made the `from` field required: the mutant `ctx.from?.language_code` in
`src/telegram/locale/locale.ts` would start to compile, reach the tests and survive. It would
turn red in the first batch run that mutates that file on a `main` that has the update: one whose
PR changed the file in code, or one that takes the whole of `src/`. The owner (2026-09-21) chose to
catch such a survivor later: a full run then cost 15+ minutes per review round, and paying that for
every dependency update cost more.

The `Makefile` is not written into the `mutation-full` row by name. `make up`, `make logs` and
the other targets do not touch the run, and by file name any change to them would take a place in
a batch for nothing. Read the file's diff instead, as with `package.json`: the recipe of the
`mutation` target or a variable it expands (`DC_APP_RUN`, `FILES`) touched — `mutation-full` too.
The recipe is the launch:

- it sets `TSX_TSCONFIG_PATH=./tsconfig.check.json`, by which the type checker decides which
  mutant gets `CompileError`;
- it sets `MUTATE` from `files`, or from `mutation_batch.py files <N>` for `batch=<N>`;
- it holds the wrapper command itself, `node --require tsx/cjs test/mutation-run.ts`.

Changing any of them changes the outcome of every mutant: the same argument that puts the
tsconfigs in the row.

The `Makefile` turns on `test-fonts` the same way: the recipe of the `test-fonts` target or the
`DC_APP_RUN` and `DC_APP` it expands touched.

## Comments-only diffs

Comments only is a statement about the content of the diff, not about lines that look like
comments. Read the diff. It is not comments only when it holds:

- a changed option, path, glob, argument or string literal. `//` inside a string or a template
  literal is not a comment. `.mocharc.json` and both tsconfigs are JSONC, and
  `"spec": "test/**/*.spec.ts"` carries `**` inside a string literal, so a grep for `//` or `*`
  decides nothing;
- a hunk that touches a comment and code on the same line;
- a tool directive. Each is read by a gate, so it is an input, not text. A directive is a comment
  any line of which opens with `///`, with `@` or with the name of a tool (Stryker, eslint,
  istanbul, prettier) past the comment marks: TypeScript reads `@ts-ignore` on the last line of a
  block comment too. `.ts` has more of them than the run's tools do: `// Stryker disable …`,
  `// Stryker restore …`, `// eslint-disable…`, `// @ts-expect-error`, `// @ts-ignore`,
  `/* istanbul ignore … */`, `// prettier-ignore`, `/// <reference … />`;
- a comment that changes which line a directive covers: its line break moves code off that line,
  or a comment between the directive and its code changes. A directive acts by line:
  `// Stryker disable next-line` over a `for` header no longer reaches the `<` a comment pushed
  onto the next line.

A `.sh` is not read this way: a comment there can be a shebang or a linter directive, and its
comments-only diffs were not measured.

### The tools of the `mutation-full` row

A comments-only diff of these files leaves the gate off. A comment is neither an option the runner
reads nor an input of the type checker. None of these files is mutated either: `mutate` in
`stryker.config.mjs` admits only globs that hit a `.ts` under `src/`, and checks that. So a
comment changes the outcome of no mutant, while the gate takes a place in a batch.

### `.ts`

A comments-only `.ts` diff turns off `bug-hunt-high`, `smells`, `docs-sync`, the `.ts` part of
`mutation-full` and of `test-fonts`, and turns on `comments` instead. The `.ts` diff is every
`.ts` of the PR taken together: one changed line of code in any `.ts`, and every row goes by name,
with the full review for the whole PR. A `.ts` that is added, deleted, renamed, copied or changes
mode is code too, whatever its hunks hold, and a rename has no hunks. Renaming a migration breaks
the append-only rule that only the full review checks. Renaming `test/x.spec.ts` to `test/x.ts`
drops its specs from the `.mocharc.json` glob while `test` stays green.

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

The gates that run the code stay on by name. `build`, `typecheck`, `lint`, `format-check` and
`test` take seconds, and a directive the reading missed still changes their outcome.

`test-fonts` runs code too, yet goes off: it takes about half a minute, and no directive acts on
it. `tsx` loads the check without checking types, and the directives of eslint, prettier, Stryker
and istanbul belong to other runs.

`mutation-full` runs code too, in the batch run, yet goes off: its price is not seconds but a place
in a batch. The status of a mutant changes only through a directive, and a diff that touches one or
the line it covers is not comments only (above). Two kinds act on the run: the
mark that silences a survivor (`docs/architecture/testing.md`, "Working through survivors"), which
acts only in a mutated file, and the `@ts-` comments of a source or a spec, by which the type
checker decides who gets `CompileError` ("The type checker" there).

## Bug hunt and smells

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
rules is a judgement, not such a sign. That is why `src/telegram/outbox/`, `src/telegram/inbox/`,
`src/telegram/retry-delay/` and `src/telegram/bot-api-failure-classifier/` are in the list while
the rest of `src/telegram/` is not: they hold the algorithms of the outbox and the inbox, the
retry delay and the rules of which failed call is which class, not a wrapper around grammY. The
list is an allowlist on purpose, and that has a price: a new or moved module with rules drops out
of the gate silently until it is written in here. The PR that creates or moves the module writes
it in.

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

## `mutation-full`

The gate is turned on by a change of code and by a change of the run's tools. Changing the tools
changes the run of every mutant, not of the diff's lines. The tsconfigs and `typescript` are tools
too: by them the type checker decides which mutant gets `CompileError` and which goes to the tests
(`docs/architecture/testing.md`, "The type checker"). The gate runs no mutants in the PR: neither
the author nor the reviewer runs `make mutation`. The issue the PR closes is recorded in a batch
instead, and once per batch `make mutation batch=<N>` runs on fresh `main` over the files its PRs
changed in code, a spec standing for the files of `src/` it and its helpers import. A PR of the
batch that changed a tool of the run, as the `mutation-full` row of the table names them, sends the
batch to the whole of `src/`. The author records the issue after the PR is created
(`make mutation-full-record issue=<M> pr=<N>`), and the review checks the record
(`make mutation-full-check pr=<N>`): an issue not recorded together with this PR is red, and so is
a PR that closes no issue and has no record of its own. How a batch is kept and how its files are
chosen is in the docstring of `scripts/review/mutation_batch.py`; "comments only" there goes by the
rules above.

A run of the PR's own area went until #712, and the owner (2026-09-30) dropped it for its price. It
was paid on every review round, and parallel sessions on one machine slow each other down 3–8×: on
2026-09-29 four area runs overlapped and took 16–32 minutes, while the same areas took 4–9 on an
idle machine, and PR #693 ran its area 8 times, about two hours in total. A batch run is paid once,
by one session.

Until #906 the batch run mutated the whole of `src/`, the files no recorded PR touched included, and
took hours (batch 1, #701). The owner (2026-10-09) chose the files the batch changed. The accepted
cost: `container.ts`, `tokens.ts` and a file whose spec helper changed under it are reached only
when a recorded PR changed them in code.

The accepted cost of the batch itself: a weak test is found only by the batch run, possibly weeks
after the PR that brought it, and its survivors are fixed by the session of the batch, not by the
PR's author. A PR that breaks the run itself (a Stryker update, say) shows that only in the batch
run too.

## `test-fonts`

The gate runs `make test-fonts`, the conversion check (`docs/architecture/testing.md`, "The
conversion check"). `make check` runs it too, but the review does not run `make check`: without the
gate a PR that breaks a conversion would pass the review green whenever its author skipped
`make check`.

The row is the domain of the convertor, the files of the check itself and the fixtures it
converts. `Dockerfile` is in it because it decides the Debian release fontforge comes from, and a
new engine version is exactly what the check is for. It installs `fontforge-nox` without a version,
so a point update of the package within the release reaches the image through a rebuild alone, and
no diff turns the gate on for it. `package-lock.json` is in the row for the same reason: the
convertor runs part of a conversion through npm dependencies (`saxes` parses an SVG source,
`mtx-decompressor` decompresses a compressed EOT), and a new version of one changes a conversion
the way a new fontforge does. The file goes by name rather than by content: telling a dependency
of the convertor from the others would take a reading, and the gate costs less than one.

Code the check imports from outside these paths, `src/shared/process/` that starts the engine among
it, does not turn the gate on: the `test` gate still runs the real engine through it in
`font-forge-convertor.spec.ts`, and the check costs about half a minute per round (the timing is in
`testing.md`).

## `docs` and `docs-sync`

`docs` and `docs-sync` look at documentation drift from two sides, so different files turn
them on. `docs` is for a text change: the changed lines of `*.md` are checked. `docs-sync` is
for a code change: the documentation the PR did not touch is checked. `docs` turns on no run,
so a documentation-only diff still gets by without the database and containers.
