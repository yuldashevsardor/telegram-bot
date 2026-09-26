import { existsSync, globSync } from "node:fs";

// Mutation testing, run by make mutation. Why it is set up this way and how to work through
// survived mutants — docs/architecture/testing.md, "Mutation testing".

// The specs that need the database. Stryker runs the specs without test/database-hook.ts, and
// without the hook they fail on reading TEST_DATABASE_NAME, so they are excluded. A new spec of
// that kind fails the first Stryker run until it is written in here. To find them:
// grep -rln testDatabaseName test --include='*.spec.ts'.
const DATABASE_SPECS = [
    "test/platform/database/database.spec.ts",
    "test/telegram/session/pgsql-storage.spec.ts",
    "test/telegram/user/pgsql-user-repository.spec.ts",
];

// The code whose behaviour only the specs above check. Without them its mutants would survive
// and stay uncovered because the tests do not run, not because they are weak.
const DATABASE_ONLY_SOURCES = [
    "src/platform/database/database.ts",
    "src/telegram/session/pgsql-storage.ts",
    "src/telegram/user/pgsql-repository/pgsql-user-repository.ts",
];

// An exclusion by a path that does not exist matches nothing. A moved or renamed file would be
// mutated without its specs, and its survivors would paint the run red as if the tests were weak.
// A glob by file name would survive a move but not a rename. DATABASE_SPECS needs no such check:
// a spec that is not written in fails the run by itself.
for (const file of DATABASE_ONLY_SOURCES) {
    if (!existsSync(file)) {
        console.error(
            `make mutation: file ${file} from DATABASE_ONLY_SOURCES is missing — write its new path into stryker.config.mjs`,
        );
        process.exit(1);
    }
}

// The area of make mutation files="…": globs separated by spaces or newlines, as in make lint. A
// comma is not a separator: it is part of the glob src/{shared,telegram}/**. The area arrives as a
// variable, not as the --mutate flag: the flag would replace the whole list together with the
// exclusions below.
const area = (process.env.MUTATE ?? "").split(/\s+/).filter((pattern) => pattern !== "");
// An area made of exclusions alone ("everything but the convertor") is subtracted from the whole
// of src/: without a positive glob Stryker would find no file at all and quietly exit with
// success.
const base = area.some((pattern) => !pattern.startsWith("!")) ? [] : ["src/**/*.ts"];

// A positive glob that finds no .ts under src/ is a typo, a directory without a glob (src/shared
// instead of src/shared/**) or a file outside src/. Stryker would only warn and exit with success
// and an empty table, so the run stops here. The :10-20 tail is the line range of Stryker, which
// globSync does not understand.
for (const pattern of area.filter((pattern) => !pattern.startsWith("!"))) {
    const files = globSync(pattern.replace(/:\d+(:\d+)?-\d+(:\d+)?$/, ""));

    if (!files.some((file) => file.startsWith("src/") && file.endsWith(".ts"))) {
        console.error(
            `make mutation: files="${pattern}" matches no .ts under src/ — the glob has to reach the files, for example src/shared/**`,
        );
        process.exit(1);
    }
}

export default {
    testRunner: "mocha",
    // all, not perTest: perTest attributes the code of before/after to the last test before the
    // hook and runs that foreign test against the mutant, which then survives falsely. The price is
    // a run several times longer (docs/architecture/testing.md, "Mutation testing").
    coverageAnalysis: "all",
    mutate: [
        ...base,
        ...area,
        // On import the entry point raises Application, a spec does not load it — as exclude in nyc.
        "!src/app.ts",
        // An area glob such as src/telegram/** catches the locales too, and Stryker cannot parse
        // a .ftl and fails: "No parser registered for .ftl".
        "!src/**/*.ftl",
        ...DATABASE_ONLY_SOURCES.map((file) => `!${file}`),
    ],
    mochaOptions: {
        // The runner takes spec from .mocharc.json, while require here replaces that list whole:
        // the same one, without database-hook.ts.
        require: ["tsx/cjs"],
        ignore: DATABASE_SPECS,
    },
    // The type checker gives a mutant that breaks the types a CompileError before the tests: tsx
    // does not check types, and such a mutant, not killed by the tests, would otherwise survive.
    // The tsconfig is the one of make typecheck: the build tsconfig.json does not see the specs.
    checkers: ["typescript"],
    tsconfigFile: "tsconfig.check.json",
    // Stryker starts half of concurrency checker processes (ConcurrencyTokenProvider in
    // @stryker-mutator/core). Without a heap limit each held 1–1.3 GB: six checkers took more than
    // 6 GB of the 7.65 of Docker and died by SIGKILL. With the limit a process holds up to 800 MB,
    // while tsc over the same tsconfig fits into 300.
    checkerNodeArgs: ["--max-old-space-size=512"],
    // The default, written out after a measurement under perTest. At 30000 the run took three times
    // as long, and 3 mutants of 210 changed their status, from Timeout to Killed: both mean
    // "detected".
    timeoutMS: 5000,
    // The threshold is here rather than in the review skill, so any make mutation checks it: the
    // review gate and the author's run over an area alike, the way any test:coverage checks the nyc
    // threshold in package.json. 100, not 99: the score is a percentage of the mutants of the area.
    // 99 over the whole of src/ lets a couple of dozen survivors through, and over an area of twenty
    // mutants none. 100 means "not a single survivor" over an area of any size.
    thresholds: { break: 100 },
    // json is the source of the run record: the make mutation wrapper (test/mutation-record.ts)
    // takes the mutated files, the statuses and the mutants from it, not from the clear-text output.
    reporters: ["clear-text", "progress", "html", "json"],
    // Otherwise clear-text prints all five hundred-odd tests of the run under the table.
    clearTextReporter: { reportTests: false },
    // The sandbox copies the whole project; the volumes with temporary files and reports are of
    // no use to it.
    ignorePatterns: ["/tmp", "/coverage", "/reports"],
};
