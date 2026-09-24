# Tests and checks

- `mocha` through `.mocharc.json` (`tsx/cjs`). The same `tsx` loads `src/app.ts` in
  `npm run dev`, and it resolves the `paths` aliases by itself, so no separate path resolver is
  needed. Its tsconfig comes from `TSX_TSCONFIG_PATH=./tsconfig.check.json` in the npm scripts
  and in the recipe of the `mutation` target: `compilerOptions` apply only to the files of the
  tsconfig `include`, and `test/**` is in `tsconfig.check.json` alone — the build
  `tsconfig.json` is limited to `src` and cannot be widened, the tests would end up in `build/`.
  Without that the files of `test/` would be compiled with the esbuild defaults: standard
  decorators instead of `experimentalDecorators` and `useDefineForClassFields: true` instead of
  the project's `false` — a decorator in a spec would fail, and a class field would silently
  become `undefined`. Types `tsx` does not check, `npm run typecheck` does, by the same
  `tsconfig.check.json`. Migrations go past `tsx`: `node-pg-migrate` loads them with its own
  jiti ([`storage.md`](./storage.md)).
- What is covered is visible in the `test/` tree and in the `make coverage` report; how it is
  counted and what is left out of it is in "Coverage" below.
- The fonts for the tests are in `test/fixtures/fonts`; where they come from and how to rebuild
  them is in `test/fixtures/fonts/README.md`.
- Specs get access denials through `chmod`, and root passes `access(2)` whatever the permission
  bits are: from root those tests fail. In the image the run goes as `node` (`USER` in the
  `Dockerfile`).
- Type strictness and the linter rules are set in `tsconfig.json` and `.eslintrc.js`, where
  comments explain the non-obvious exceptions; why `skipLibCheck` is on is at the flag itself.
  The exceptions to `no-console` are covered in [`logging.md`](./logging.md).
- The gate before a PR is `make check`, and the tests in it run with the coverage threshold
  ("Coverage", "Threshold"). Nothing enforces it: `pre-commit` is a convenience of host
  development (the root [`README.md`](../../README.md), "The pre-commit hook"), and CI is not
  set up yet (issue
  [#116](https://github.com/yuldashevsardor/telegram-bot/issues/116)).
- The actions of the review skills (`scripts/review/`) are Python run on the host, not in the
  image: they drive `docker` and `git` from outside the containers. Python 3.9 syntax, the
  version of `/usr/bin/python3` on macOS, and the standard library only, so the host needs no
  `pip`. `make review-test` runs their specs with `unittest`, which replace the calls to
  `docker` and `git`; `make check` does not run them, it runs in the container. No linter
  checks them yet. In review they are the `python` gate (`docs/agents/review-gates.md`).
- `.claude/settings.json` hangs `scripts/claude-worktree-guard.sh` on the session start and on a
  file edit: an edit in the main tree is rejected. Edits made through the shell the hook does
  not see. On the start it also compares `.claude` against `origin/main` (`stale_claude` in the
  script, `git diff --name-only HEAD...origin/main -- ':(top).claude'`) and names the files that
  differ.
  A session reads the text of a command or a skill from disk once — at the first use of the file
  — and does not re-read it afterwards: an edit to a file it has already used never reaches it,
  while an edit to a file it has not used yet does. So a lagging tree feeds the session an
  instruction that is no longer on `main`, and the session has nothing to notice it with: the
  agent does not open the file itself. For the same reason there is one fix — pull the tree up
  and restart the session: what has been read in it will not be refreshed.

## The test database

Specs that go to PostgreSQL use a database of their own per run, inside the shared Postgres from
`docker-compose.db.yml`. It is kept by the mocha root hook `test/database-hook.ts`, wired in
`.mocharc.json`:

- before the specs the hook connects as the superuser (`DATABASE_SUPERUSER_*` reach the `app`
  container through `env_file`), creates the database `telegram_bot_test_<suffix>` owned by
  `DATABASE_USER_NAME` and applies the migrations to it with the programmatic `runner` from
  `node-pg-migrate`; the migrations directory and table come from `migrate.json`, the same as
  for the container before the bot starts;
- the specs and the migrations go to the database as the application user, like the bot;
- after the run the database is dropped with `drop database … with (force)`. A run killed before
  `afterAll` leaves its database behind — `\l telegram_bot_test_*` in `make psql` shows it.

A run does not collide with a bot from another tree: the bot has `DATABASE_NAME`, the run has
one of its own. Parallel runs from different trees are kept apart by the suffix.

A spec gets the database name from `TEST_DATABASE_NAME` rather than from a substituted
`DATABASE_NAME`: `.mocharc.json` is not mounted from the host, so in a stale image the hook is
not wired in while the specs from the mounted `test/` still run. Without a variable of its own a
spec fails; with `DATABASE_NAME` it would have truncated the tables of the shared database of
running bots. Specs read the variable through the shared `testDatabaseName()` from
`test/database.helper.ts`.

The tables are truncated by the spec itself — a `truncate` of its own table in `beforeEach`. A
root `beforeEach` would go to the database before every test of the run, although only a handful
of them touch it.

That is why `make test`, `make check` and `make coverage` need a running `pgsql` container, not
just its network. Without the database the hook fails, and the specs are not skipped silently:
`make coverage` runs the same set, and a skip would quietly eat into coverage.

Rejected alternatives:

- **A transaction rolled back per test.** `now()` in Postgres is the time the transaction
  started, so `updated_time = now()` in `PgsqlStorage.write()` would coincide with the
  `created_time` of the insert, and the update could not be checked. `Database.close()` closes
  the pool and does not fit into a shared transaction.
- **Testcontainers.** The tests run in a one-off `app` container, and to raise a database
  container from it, `/var/run/docker.sock` would have to be passed into `app` — root over the
  host Docker from the application container, plus a separate setup of the database address on
  Docker Desktop.
- **PGlite, pg-mem.** They check the wrong Postgres: pg-mem is an emulator with incomplete SQL,
  PGlite is a separate WASM build with a single connection that the `postgres` driver reaches
  over TCP only through a shim. A green test would speak of the substitute, not of our SQL.

## Coverage

`make coverage` runs `npm run test:coverage`: the same specs under `nyc`, configured by the
`nyc` key in `package.json`.

**Threshold.** `check-coverage` in the same key switches the threshold on, and `lines`,
`branches`, `functions` and `statements` next to it set it for each metric — 99. The threshold
is global: it is counted over the sum of all the files of the report, so a shortfall in one file
hides in the surplus of the rest while the total stays at or above the threshold. Once even one
metric is lower, `nyc` — after the specs have already gone green — prints
`ERROR: Coverage for <metric> (…%) does not meet global threshold (99%)` and exits with an error.

The threshold is checked by any run of `npm run test:coverage`: `make coverage`, the `check` npm
script under `make check` and the `test` gate of PR review, under which `pr-light-check` runs
`make coverage` (`.claude/skills/pr-light-check/SKILL.md`). `npm test` and `make test` know
nothing about the threshold, so CI (issue
[#116](https://github.com/yuldashevsardor/telegram-bot/issues/116)) will get it only if it calls
`npm run check` or `npm run test:coverage`.

**The source TypeScript is counted, not the tsx output.** `test/coverage-hook.ts` replaces the
`.ts` loader for the files of `src/`: it instruments the source through
`istanbul-lib-instrument` and transpiles it itself, through esbuild with the tsx options and the
same `TSX_TSCONFIG_PATH`. The tsx output will not do: esbuild puts its own helpers
(`__copyProps`, `__decorateClass`, the trailing `0&&(module.exports=…)`) on the same line as the
code of the file, and when istanbul maps them back through the source map it attributes their
branches and functions to the lines of the source. A file without a single conditional had
`Branch` at 75%, and the total was overstated. c8 does not cure that: V8 coverage is taken from
the esbuild output too, and the phantoms there are the same. The own hook of nyc is switched off
(`hookRequire: false`), so the only thing that instruments is `coverage-hook.ts`. If the hook
does not get wired in, the report shows zeros rather than quietly falling back to the phantoms.
In the script `--require tsx/cjs` repeats `.mocharc.json` for a reason: a `--require` from the
mocha command line runs before the config, and without the repetition the TypeScript hook would
be loaded before tsx.

**Files that were not loaded.** `all: true` adds to the report the files the tests did not load
either: nyc reads them from disk and parses them with babel using the plugins from
`parserPlugins`. The hook takes the same list from `NYC_CONFIG`, so a loaded and a non-loaded
file are parsed alike. Without `decorators-legacy` the parsing of a file with a decorator failed
and nyc silently dropped the file from the report. `exitOnError: true` turns such a failure into
a failed run. The list is written out in full rather than inherited from
`@istanbuljs/nyc-config-typescript`: `extends` in nyc is applied on top of the local keys, and a
plugin cannot be appended to a preset. `cache: false` is the second and last key of that preset.

**Left out of the report:**

- everything outside `src/` (`include`). The tests do not execute the migrations; how those are
  loaded is in the first bullet of the list above;
- `src/app.ts` (`exclude`). On import the entry point immediately raises `Application` and hangs
  the signal handlers, so a spec will not load it;
- files without executable code (`skipEmpty`): types and interfaces only, empty error classes.
  There is no list, nyc decides for itself; in `coverage/lcov.info` they stay with `LF:0`.

## Mutation testing

`make mutation` runs StrykerJS: it puts one mutation at a time into the source — changes an
operator, a literal, a condition — and watches whether at least one spec fails. A survived
mutant shows behaviour the tests do not hold, although the line is covered. The target is not
part of `make check`: there it would run on every edit and over the whole of `src/`. The
threshold and the review gate are in "Threshold" below.

**Running.** `make mutation files="src/shared/**"` narrows the run to an area: globs separated
by spaces (a comma is part of a glob, as in `src/{shared,telegram}/**`), `!` excludes; an area
made of exclusions alone is subtracted from the whole of `src/`. Without `files` the whole of
`src/` is mutated. Excluded from any area, and from the whole of `src/` as well, are:
`src/app.ts` — on import the entry point raises `Application`, and a spec does not load it (as
with `exclude` in nyc); the `.ftl` locales — the glob of an area catches them, and Stryker
cannot parse them and fails; the code under the database specs — below, "The database hook is
not wired in". The result is a table in the terminal, `reports/mutation/mutation.html` and
`mutation.json` on the host and the record of the run next to them (below, "The run record"); in
the report every mutant carries its status, the test that killed it and the reason. The list of
covering tests there is empty: with `all` coverage Stryker does not collect it. The config is
`stryker.config.mjs`; it is mounted into the container and needs no `make rebuild` after an
edit, and each of its non-obvious values is explained by a comment right there.

**Threshold.** `thresholds.break: 100` in `stryker.config.mjs`: a single survived or uncovered
mutant in the area, and Stryker prints
`Final mutation score <score> under breaking threshold 100` and exits with an error; why 100 and
not 99 is in a comment there. The threshold is checked
by any `make mutation`: working through an area, the run of the author before a PR
(`.claude/commands/solve-issue.md`) and the `mutation` and `mutation-full` gates of PR review
(`docs/agents/review-gates.md`), under which `pr-light-check` runs the target over the area of
the diff or over the whole of `src/`, or else accepts the run record of the author (below, "The
run record"). While the area holds a survivor nobody has worked through, a run over it stays
red — that is a sign of unfinished work, not a failure.
An area without a single mutant in the score — no code, only errors (`CompileError`,
`RuntimeError`) or only mutants silenced by a mark (`Ignored`) — is invisible to the threshold:
its score is `NaN` (`DEFAULT_SCORE` in `mutation-testing-metrics`), `NaN < 100` is false, and
the run is green having checked nothing.

**The run record.** The target runs Stryker through the wrapper `test/mutation-record.ts`: once
the run is over, whatever its outcome, the wrapper writes `reports/mutation/record.md` and exits
with the exit code of Stryker. The record exists so that the reviewer does not repeat the run of
the author of a PR: the author publishes it in the PR, and the review gate may accept it instead
of a run of its own (the rules of acceptance are in the author run record section of
`.claude/skills/pr-light-check/SKILL.md`). The first line of the record is a marker, invisible
in the PR:

```
<!-- mutation-record head=<sha> clean=<yes|no|unknown> scope=<full|files> exit=<code> score=<score|NaN|none> -->
```

`head` is the commit at the moment of the start, `clean=yes` means `git status --porcelain` was
empty: a run on a dirty tree checked something other than the commit. Both are counted by the
host in the recipe of the target — `.git` is not mounted into the container — and counted by two
substitutions, each with an exit code of its own. If `git status` exited with an error (not a
repository, an unreadable `.git`), it is `clean=unknown`, and `head` stays in the record. That
the substitutions yield exactly these values is checked by the review of a PR that touches the
recipe (`.claude/skills/pr-light-check/SKILL.md`, the `make-targets` gate): expanding the recipe
is not enough here — `make -n` does not execute the counting chain — while a run under
`mutation-full` goes on a clean tree, where `clean=yes` is what is expected anyway. The reverse
does not happen: with no `head` the wrapper sets `unknown` for `clean` as well, because a record
without a commit will not be accepted by review and the cleanliness of the tree decides nothing
in it. `scope=full` means `files` was not passed and the whole of `src/` was mutated. `exit` is
the exit code of `npm run mutation`, or, if that died from a signal, `128 + the signal number`;
when Stryker itself dies from a signal (OOM), npm outlives it and returns an ordinary non-zero
code. `score` is the score from `Final mutation score`: the wrapper counts it over the report by
the same formula as Stryker (`score()` in the wrapper); `none` means there is no report, the run
broke off before it (a config error, a crashed checker, Ctrl-C). Under the marker is the same in
words plus a summary of the run (`record()` in the wrapper); the place of a survivor is written
the way `clear-text` prints it.

An untracked file counts the same as a changed one: the sandbox of Stryker is narrowed only by
`ignorePatterns` (`stryker.config.mjs`) on top of its built-in list, and not by `.gitignore`, so
an uncommitted source goes under mutation through the `mutate` glob and an uncommitted spec goes
into the run through the `spec` glob from `.mocharc.json`. That is why a file the run does not
read is taken out of the count by `.gitignore` rather than by a flag of `git status`: that is
how `.DS_Store` ended up there.

The files, the mutants and the statuses the wrapper takes from the JSON report of Stryker (the
`json` reporter in the config), not from the terminal output. A file without a single mutant is
absent from the report, so a file of types alone does not make it into the list of mutated files
even if it was in the area. The old record and the old reports the wrapper deletes before the
run: a run that breaks off will not leave any of its own, and the previous ones would pass
themselves off as its result. The record goes into a PR, and a GitHub comment holds 65,536
characters, so it carries only the summary and the mutants that were not killed. The limit
stands on the record as a whole: as soon as it grows to 60,000 characters, the wrapper cuts the
list of survivors off with a line "and N more". Everything before that list — the summary and
the list of mutated files — is not limited by anything. The remainder stays in `mutation.html`
on the machine of the run and travels nowhere with the record, so a cut-off list is a reason for
the reviewer to run the target instead of accepting the record.

A run stops on Ctrl-C when the output goes to a terminal: the signal reaches the whole process
group of the container, Stryker is killed, and the wrapper — it is PID 1, and a signal without a
handler is not delivered to it — lives on to the record and writes it with `exit=130`. When the
output is redirected into a file or a pipe, the container has no terminal, `docker compose` lets
the client go, `make` returns 130, and the run inside the container carries on and is stopped
only by `docker stop`.

**Why Stryker and the `mocha` runner.** There is no living alternative to StrykerJS with
TypeScript support: `mutode` and `grunt-mutation-testing` have not been updated in npm since
2022 (`npm view <package> time`). The `command` runner knows nothing about the tests
(`CommandTestRunner` in `@stryker-mutator/core`): Stryker would see only the exit code of
`npm test`, without the killing test and the reason, and the specs would go through
`.mocharc.json` together with the database hook. The `mocha` runner takes the specs and the
`require` from the `mochaOptions` of the config and names, for every mutant, the test that
killed it. Runner 10.0.0
does not find the internals of mocha 12, renamed to `.cjs`, so the `mutation` npm script wires
`test/stryker-mocha-hook.cjs` in through `NODE_OPTIONS`; the mechanics and the condition for
removing it are in that file.

**Coverage `all`, not `perTest`.** With `perTest` Stryker would run against a mutant only the
tests that executed it, but the id of the current test is set by the runner in a root
`beforeEach` and is not reset between tests. Code from the `before`/`after` of a `describe` is
recorded against the test that ran last before the hook — usually one from a different spec —
and a mutant its own spec would have killed survives: deleting `this.bind()` from
`Container.setup()`, which `container.spec.ts` calls in `before`, was attributed to the last
test of `config-container.spec.ts`. Over the whole of `src/` there were 37 such false survivors
out of 316, and in `bootstrap/` 33 out of 92. With `all` no per-test coverage is collected:
every mutant counts as static, all the tests go against it, and since the `mocha` runner cannot
reload modules, Stryker raises a new worker for every mutant (`ReloadEnvironmentDecorator` in
`@stryker-mutator/core`). Hence the price: in the measurement of
[#334](https://github.com/yuldashevsardor/telegram-bot/issues/334) the whole of `src/` took 8.5
minutes against a minute and a half, an area from 25 seconds to three minutes; the price today
is in "The type checker". The review gate runs the area of the diff, and at a threshold of 100 a
single false survivor would be enough to paint it red, so the precision is worth those minutes.
Going back to `perTest` is possible only after making the specs resistant to a repeated run:
under it a worker runs mocha many times in one process, while `container.spec.ts` and
`bulk-messages.command.spec.ts` hold state from the load of the file, fail on the second run and
give false `Killed`.

**The database hook is not wired in.** Root hooks from `require` fire on every mocha run, and
Stryker has a run per mutant (`MochaTestRunner` in `@stryker-mutator/mocha-runner`), so
`test/database-hook.ts` would create a database, apply the migrations and drop it for every
mutant, even one whose tests do not touch the database. On the 330 mutants of `eot-packer/` that
is 50 s against 10 s for the same outcome (measured with `perTest`), and the workers would be
creating databases in the shared Postgres without a pause. So the `require` in the Stryker
config carries no hook, and the database specs are excluded (`DATABASE_SPECS`): without the hook
they fail, and a new spec of that kind will fail the first Stryker run until it is written into
the list. The code whose behaviour only they check (`DATABASE_ONLY_SOURCES`) is taken out of
`mutate`: without those specs 43 of its 46 mutants would stay survived or uncovered, while with
the hook 2 survive. The list holds exact paths, and a path that is not in the tree stops any
`make mutation` with the message `file … from DATABASE_ONLY_SOURCES is missing`: otherwise the
exclusion would match nothing, and a moved or renamed file would give false survivors.

**The type checker.** `tsx` does not check types, so without a checker a mutant that breaks the
types would go into the tests like any other and, not killed by them, would survive.
`@stryker-mutator/typescript-checker` checks the mutants before the tests, by
`tsconfig.check.json`, and gives such a mutant `CompileError`: it does not count towards the
score and needs neither working through nor a mark. The tsconfig is the same as for
`make typecheck`, but the checker strips `noUnusedLocals` and `noUnusedParameters` from it and
turns
`allowUnreachableCode` on (`COMPILER_OPTIONS_OVERRIDES` in `tsconfig-helpers.js` of the checker
package): a mutant whose whole error is an unused variable or unreachable code goes into the
tests. Before the run the checker compiles the whole project, and a type error in any file stops
any `make mutation`, even one with a narrow area: `TypescriptChecker.init()` in
`typescript-checker.js` of the package throws
`Typescript error(s) found in dry run compilation`. The checker works on any run, with an area
and without. It hardly makes the run
more expensive: with `all` coverage every mutant costs a run of the whole set of specs, and one
weeded out by the checker never reaches the specs. In the measurement of
[#378](https://github.com/yuldashevsardor/telegram-bot/issues/378) more than a quarter of the
mutants went to `CompileError`, the whole of `src/` took 14 minutes against 18 without the
checker, an area from −8 to +12 %. The former 54 minutes for the whole of `src/`
([#334](https://github.com/yuldashevsardor/telegram-bot/issues/334)) were measured with
`perTest` and without a memory limit for the checker; what the limit is for is in
`stryker.config.mjs`.

The checker process can fail in two ways. `Checker process […] crashed with exit code null` — it
was killed by SIGKILL: the memory of Docker is one for all the trees, and while an image is
being built or somebody else's run is going on next door, there is not enough of it even with
the limit. That is a failure of the machine, not of the code, and the run is repeated once the
neighbours free the memory. `Checker process […] ran out of memory` — the checker hit its own
heap limit: the neighbours have nothing to do with it, every run will fail the same way, and
what has to be raised is the limit in `checkerNodeArgs`.

Both lines are written by `CheckerRetryDecorator` (`@stryker-mutator/core`), and the prefix
`Checker process` is put there by it alone. The failures themselves are caught by
`ChildProcessProxy.handleUnexpectedExit()`, which prints about any child process, the runner
included: `Child process [pid …] exited unexpectedly with exit code null (SIGKILL)` and
`Child process [pid …] ran out of memory` (the latter when the output of the process contains
`JavaScript heap out of memory`). So a line without the prefix says nothing about the checker.
They have to be told apart because only the checker breaks off the run: a runner that failed on
a mutant Stryker restarts, giving the mutant `RuntimeError` ("Timeouts and errors"), while its
failure on the initial run breaks the run off with a message of its own —
`Something went wrong in the initial test run` (`3-dry-run-executor.js` of the package).

The decorator wraps the checks (`check`, `group`): a failed one Stryker repeats once in a new
process, and if the repeat fails too, the run breaks off with an error and no
`Final mutation score`. The initial compilation (`init`) it does not wrap — that one is not
repeated at all, and such a failure gives no line of its own with the prefix: all that stays in
the log is `Child process [pid …]` from `ChildProcessProxy`.

**Timeouts and errors.** The runner creates Mocha with `timeout: 0`; a hung mutant is caught by
Stryker itself and counted as `Timeout` — that is "detected", on a par with `Killed`. The
mutants of `TelegramCallApiMiddleware`, of `withTimeout()`/`sleep()`, of the loop in
`FontSignatureMatcher` and of the fontforge launch hang for real: an eternal promise, an endless
loop, a process waiting for input. `timeoutMS` is left at the default, and why is in the config.
On a loaded machine (a neighbouring session running a mutation run of its own) a healthy but
slow test does not fit into the deadline, and the status lies. For specs without a deadline of
their own a survivor becomes a `Timeout`. Specs with their own `this.timeout()` — printed by
`grep -rln 'this.timeout(' test --include='*.spec.ts'` — are failed by mocha with "Timeout of
…ms exceeded", and a survivor hides under `Killed`. The same goes for polling with a deadline of
its own (`Date.now() > deadline`), whatever it is called and whatever it fails with when the
deadline passes (the specs with it are printed by `git grep -ln 'Date.now() > deadline' test`):
the reason of such a `Killed` is the ordinary message of the spec.
With `all` coverage the whole set goes against every mutant, so under load such polling "kills"
a mutant from any file, not only from its own. The status drifts the other way too: in the
measurement of the map in
[#334](https://github.com/yuldashevsardor/telegram-bot/issues/334), where the workers shared the
cores with the compiler of the type checker, 9 killed mutants became survivors; the checker ran
then without a memory limit, and with the limit a single full run in the measurement of #378 did
not lose a single killed one. The limit fixes the memory, not the competition for the cores: in
the same measurement a full run with the limit at a load average of 22–33 sent 281 killed
mutants to `Timeout`. A suspicious status is rechecked by a run over the area on an idle
machine. The error column adds up `CompileError` and `RuntimeError`; they do not count towards
the score. `CompileError` needs no working through ("The type checker"). Static mutants on which
the module does not load (`shared/tokens.ts`, the fields of `FontSignatureMatcher`) used to give
`RuntimeError` without the checker, and with it they are weeded out before the tests as
`CompileError`. A remaining `RuntimeError` with the reason `Test runner crashed. Tried twice…`
is a mutant on which the runner failed twice (`RetryRejectedDecorator` in
`@stryker-mutator/core`): nobody checked it, and a survivor may be hiding underneath. Such a
status is suspicious and is rechecked, like the rest, by a run over the area on an idle machine.

**Working through survivors.** A survived or uncovered (`NoCoverage`) mutant is the question "is
this behaviour required?", not "which test would kill it?". There are three outcomes:

- the behaviour is required — a test that pins it down;
- the mutant is equivalent: in everything required of the program it is indistinguishable from
  the original — a mark in the code;
- the behaviour is not required — the code is not touched by the task of the area, a separate
  issue is filed, and the mutant is silenced by a mark linking to it: at a threshold of 100 a
  live survivor paints a run over this area red for everybody while the issue is open.

Indistinguishable by what is required, not byte by byte. A boundary mutant shifts a check by one
byte, and if it differs from the source only on input that is rejected either way, it is
equivalent: all that changes is which check rejected the input — the class, the text and the
details of the error (`readFontData()` in `eot-packer.ts`). The details are checked by a test
when without them it is not visible whether the check works at all: an envelope whose font is
one byte too large to fit past the fixed part of the header would have been rejected by the
matching of the names against the beginning of the font as well (`eot-packer.spec.ts`). The same
holds if the mutant differs only on a file the domain is not obliged to let through: twelve
bytes of an sfnt header without a single table one version lets through and the other rejects
(the constructor of `SfntReader`). The same goes for a deadline: `<=` instead of `<` against
`Date.now()` in `RateLimit.isFree()` moves the end of the cooldown by a millisecond, while the
limit "`number` calls per `interval`" is honoured by both variants. A test on such a boundary
would pin down an arbitrary diagnostic, the admission of a non-font or a millisecond of a
deadline.

The text of a message — of a log entry of any level or of an error — is a requirement: it is
what an entry is searched and read by, and without it nothing but the details is left of the
entry. A survived `StringLiteral` that emptied a message is closed by a test that matches the
text in full (`bot.spec.ts`, `filter.spec.ts`). This does not contradict the paragraph above:
there the message stays, and all that changes is which check rejected the input. The test
commands `/font_generator` and `/bulk_messages` are worked through like the rest of the code
(the overview in [`README.md`](./README.md)).

A mark is a comment on the line above the mutated one:
`// Stryker disable next-line <mutator>: <replacement> — <why>`. The name of the mutator comes
from the report (`StringLiteral`, `ConditionalExpression`), several of them through a comma;
`all` in place of a name would silence mutants on that line nobody has worked through yet. A
note in the PR is not enough: every next run and every next session would work through the same
survivors again.

A mark cannot pick a single replacement: the name of a mutator silences all of its replacements
on the line, killed ones included, and in the report its reason stands against each of them. If
`true` survived at `if (x === undefined)` while `false` was killed, a `ConditionalExpression`
mark without a qualification would call both equivalent. That is why the reason starts with the
replacement it belongs to. A mark can also open up a new survivor: `CallExpression` deletes a
call only when the statement has no other mutants (`filter` in `empty-expression-mutator.js` of
`@stryker-mutator/instrumenter`), and a silenced mutator satisfies that condition. So after the
marks the area is run once more.
