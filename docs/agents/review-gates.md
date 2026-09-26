# Review gates

The table that turns the changed files into a list of checks. The `/review-pr` command
(step 4) applies it to the PR diff and passes the gates that are on to the review skill.

The same table answers a second question: whether a mutation run record is stale (below,
"Changes that affect the mutation run"). Both the author and the reviewer ask it, over a
different diff. That is why the table is a document of its own and not part of the routing:
three parties apply it, and with one copy nothing can drift apart.

The second use does not turn the table into routing. Neither the author nor the review skill
picks a skill or the run's gates by it: that is still done by `/review-pr` alone.

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
| `.ts` inside `src/font-convertor/`, `src/shared/`, `src/telegram/outbound-queue/` — not a comments-only `.ts` diff | `smells` |
| any `.ts` — a comments-only `.ts` diff | `comments` |
| `stryker.config.mjs`, `test/stryker-mocha-hook.cjs`, `test/mutation-record.ts`, `.mocharc.json`, `tsconfig.json`, `tsconfig.check.json` — not a comments-only diff | `mutation-full` |
| any `.ts` in `src/` or `test/` — not a comments-only `.ts` diff, unless `mutation-full` is on | `mutation` |
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
turn red on the next PR that touches that file. The owner (2026-09-21) chose to catch such a
survivor with that next PR: a full run costs 15+ minutes per review round, and paying that for
every dependency update costs more.

The `Makefile` is not written into the `mutation-full` row by name. `make up`, `make logs` and
the other targets do not touch the run, and by file name any change to them would pull a full
run: minutes on every round. Decide by the content of the change, as with `package.json`, and
read the file's diff: the recipe of the `mutation` target or a variable it expands
(`DC_APP_RUN`, `FILES`) touched — `mutation-full` too. The recipe is the launch. It sets
`TSX_TSCONFIG_PATH=./tsconfig.check.json`, by which the type checker decides which mutant gets
`CompileError`. It sets `MUTATE` from `files`. It holds the wrapper command itself,
`node --require tsx/cjs test/mutation-record.ts`. Changing any of them changes the outcome of
every mutant: the same argument that puts the tsconfigs in the row.

A comments-only diff of the files in the `mutation-full` row leaves the gate off. Read the
diff, as with `package.json` and the `Makefile` above. A comment is neither an option the
runner reads nor an input of the type checker. None of these files is mutated either: `mutate`
in `stryker.config.mjs` admits only globs that hit a `.ts` under `src/`, and checks that. So a
comment changes the outcome of no mutant, while the gate costs the whole `src/`: minutes on
every round. The gate still goes on for:

- a changed option, path, glob, argument or string literal;
- a hunk that touches a comment and code on the same line;
- a comment that is a tool directive: `// @ts-expect-error`, `// eslint-disable` and
  `// Stryker disable` are inputs, not text.

Comments only is a statement about the content of the diff, not about lines that look like
comments. `.mocharc.json` and both tsconfigs are JSONC, and `"spec": "test/**/*.spec.ts"`
carries `**` inside a string literal, so a grep for `//` or `*` decides nothing.

A comments-only `.ts` diff turns off `bug-hunt-high`, `smells`, `docs-sync` and `mutation` and
turns on `comments` instead. Read the diff, as with the files of the `mutation-full` row. The `.ts`
diff is every `.ts` of the PR taken together: one changed line of code in any `.ts`, and every row
goes by name, with the full review for the whole PR. A `.ts` that is added, deleted, renamed,
copied or changes mode is code too, whatever its hunks hold, and a rename has no hunks.
Renaming a migration breaks the append-only rule that only the full review checks. Renaming
`test/x.spec.ts` to `test/x.ts` drops its specs from the `.mocharc.json` glob while `test`
stays green.

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

Comments only is read as for the `mutation-full` row: by the content of the diff, not by lines
that look like comments. `//` inside a string or a template literal is not a comment. A hunk
that changes a comment and code on the same line is code. A tool directive is code too, and
`.ts` has more of them than the run's tools do. A directive is a comment that opens with `///`,
with `@` or with the name of a tool (Stryker, eslint, istanbul, prettier):
`// Stryker disable …`, `// Stryker restore …`, `// eslint-disable…`, `// @ts-expect-error`,
`// @ts-ignore`, `/* istanbul ignore … */`, `// prettier-ignore`, `/// <reference … />`. Each
is read by a gate, so a diff that touches one gets the full review.
`scripts/review/mutation_area.py` holds the same rule as code (`DIRECTIVE`), and its specs check
it against this list.

The gates that run the code stay on by name. `build`, `typecheck`, `lint`, `format-check` and
`test` take seconds, and a directive the reading missed still changes their outcome. A `.sh` is
not read this way: a comment there can be a shebang or a linter directive, and its comments-only
diffs were not measured.

`mutation` runs code too, yet goes off, because its price is not seconds. Its area grows from the
diff: a changed spec gives its mirror source, a changed helper the mirrors of every spec importing
it, so a reworded comment in a shared helper mutates a sizeable part of `src/`. And only a
directive changes the status of a mutant: the mark that silences a survivor
(`docs/architecture/testing.md`, "Working through survivors"), which acts only in a mutated file,
and the `@ts-` comments of a source or a spec, by which the type checker decides who gets
`CompileError` ("The type checker" there). The price is paid again at every review fix that
rewords a comment: without the exemption it makes the run record stale (below, "Changes that
affect the mutation run"), and the author runs again. The same rule goes on inside the gate, file
by file: when another `.ts` of the PR turns `mutation` on, a file whose own diff changes only
comments gives no area. That part is `make mutation-area`'s, since the area is assembled there.

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
rules is a judgement, not such a sign. That is why `src/telegram/outbound-queue/` is in the
list while the rest of `src/telegram/` is not: it holds the queue's algorithm, not a wrapper
around grammY. The list is an allowlist on purpose, and that has a price: a new or moved module
with rules drops out of the gate silently until it is written in here. The PR that creates or
moves the module writes it in.

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

`mutation` and `mutation-full` are the second such pair: both run `make mutation` and differ
in area. `mutation` mutates the code the PR touched: a survivor sits on the author's line, and
the run takes seconds. The area is assembled by `make mutation-area` over the PR tree
(`scripts/review/mutation_area.py` holds the rule): it needs the PR's code, while the table
sees only file names, and it leaves out a file whose diff changes only comments.
`mutation-full` is turned on by the run's tools, and it mutates the whole of `src/`. Changing the
tools changes the run of every mutant, not of the diff's lines, and a PR that changes only the
tools has an empty area from its diff. The tsconfigs and `typescript` are tools too: by them the
type checker decides which mutant gets `CompileError` and which goes to the tests
(`docs/architecture/testing.md`, "The type checker"). On other PRs the whole of `src/` is not
run: that is minutes on every round for lines the PR did not touch.

With the `rebuild` gate on, the image is rebuilt **before** the other checks. Otherwise new
code is checked against old dependencies and an old config, and a green result means nothing.

`docs` and `docs-sync` look at documentation drift from two sides, so different files turn
them on. `docs` is for a text change: the changed lines of `*.md` are checked. `docs-sync` is
for a code change: the documentation the PR did not touch is checked. `docs` turns on no run,
so a documentation-only diff still gets by without the database and containers.

## Changes that affect the mutation run

`make mutation` leaves a run record, and review accepts it in place of its own run
(`docs/architecture/testing.md`, "The run record"). The acceptance conditions are in the
docstring of `scripts/review/mutation_record.py`, run by `make mutation-record`. The run went
on one commit, and the record is measured against another. So whether it still holds is the
same pass over the table above, only with the diff taken between those two commits. At least
one of three gates on — the record is stale:

- `mutation` — the mutated code changed, or the specs that kill the mutants; a comments-only
  `.ts` diff between the two commits leaves it off, as it does in the PR diff;
- `mutation-full` — the run's tools changed, and they change the outcome of every mutant, not
  of the diff's lines;
- `rebuild` — the run went in a different image.

None of the three — the run is not repeated: neither by the author after the push nor by the
reviewer under the gate. Otherwise a review fix that touched only documentation would cost the
round two runs of the same area, and a full run is minutes
(`docs/architecture/testing.md`, "The type checker").

The diff here is between the record's head and the PR head (for the author, their `HEAD` once
pushed), and `make mutation-record` lists it. Condition 1 of the docstring of
`scripts/review/mutation_record.py` says why the diff is taken between the trees and not from
the merge-base, and why a record whose commit a force-push lost does not hold.

`rebuild` is not redundant in the three, although review already refuses the record when that
gate is on for the PR as a whole (condition 4 of the acceptance rule). The PR's gates are
decided by `gh pr diff`, that is from the merge-base, and merging `origin/main` into the branch
moves that merge-base. A `Dockerfile` change arriving from `main` is not visible in the PR
diff, yet it changes the image.
