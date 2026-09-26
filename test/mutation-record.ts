// The make mutation wrapper: runs npm run mutation and, whatever its outcome, writes the run record.
// The format and what the record is for — docs/architecture/testing.md, "The run record". The host
// passes the head and the cleanliness of the tree (the mutation target in the Makefile), because .git
// is not mounted into the container.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";

// The default path of the json reporter from stryker.config.mjs.
const REPORT_FILE = "reports/mutation/mutation.json";
const HTML_FILE = "reports/mutation/mutation.html";
const RECORD_FILE = "reports/mutation/record.md";
// The record goes into a PR as a comment, and that holds 65,536 characters; the slack is for the
// signature of whoever publishes it.
const RECORD_LIMIT = 60_000;
const STATUSES = ["Killed", "Timeout", "Survived", "NoCoverage", "CompileError", "RuntimeError", "Ignored", "Pending"];

type Mutant = {
    mutatorName: string;
    replacement?: string;
    status: string;
    location: { start: { line: number; column: number } };
};

type Report = { files: Record<string, { mutants: Mutant[] }> };

type Run = { exitCode: number; startedAt: Date; finishedAt: Date };

function readReport(): Report | string {
    try {
        return JSON.parse(readFileSync(REPORT_FILE, "utf8")) as Report;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "Stryker wrote no report, the run broke off before it";
        }

        return `the report was not read: ${(error as Error).message}`;
    }
}

// The same formula as mutationScore in mutation-testing-metrics, by which Stryker prints the Final
// mutation score: errors, silenced and non-executed mutants do not count towards the score, and without
// a single mutant in it the score is NaN.
function score(counts: Map<string, number>): string {
    const count = (status: string): number => counts.get(status) ?? 0;
    const detected = count("Killed") + count("Timeout");
    const valid = detected + count("Survived") + count("NoCoverage");

    return valid > 0 ? ((detected / valid) * 100).toFixed(2) : "NaN";
}

function duration(run: Run): string {
    const seconds = Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000);

    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

// A replacement can span several lines and contain backticks of its own (the mutant of a template
// string). The markup needs a fence longer than the longest run of backticks inside, otherwise the line
// of a survivor holding `` closes the code early and the mutator and the place end up in the prose.
function inline(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    const short = line.length > 80 ? `${line.slice(0, 80)}…` : line;
    const longest = [...short.matchAll(/`+/g)].reduce((max, [run]) => Math.max(max, run.length), 0);
    const fence = "`".repeat(longest + 1);

    return longest === 0 ? `${fence}${short}${fence}` : `${fence} ${short} ${fence}`;
}

function record(run: Run): string {
    const head = process.env["MUTATION_HEAD"] ?? "";
    // A number of paths or anything else: the recipe of the target writes unknown here when git did
    // not answer. A bare Number() would not do: Number("") is 0, "clean" for a tree nobody looked at.
    const counted = process.env["MUTATION_DIRTY"] ?? "";
    const dirty = /^\d+$/.test(counted) ? Number(counted) : Number.NaN;
    const area = process.env["MUTATE"] ?? "";
    const report = readReport();
    const clean = head === "" || Number.isNaN(dirty) ? "unknown" : dirty === 0 ? "yes" : "no";
    const tree = { yes: "clean", no: `dirty, paths in \`git status --porcelain\`: ${dirty}`, unknown: "unknown" };
    const files = typeof report === "string" ? [] : Object.entries(report.files).sort(([a], [b]) => (a < b ? -1 : 1));
    const counts = new Map<string, number>();
    const undetected: string[] = [];

    for (const [file, { mutants }] of files) {
        for (const mutant of mutants) {
            counts.set(mutant.status, (counts.get(mutant.status) ?? 0) + 1);

            if (mutant.status === "Survived" || mutant.status === "NoCoverage") {
                const { line, column } = mutant.location.start;
                const replacement = mutant.replacement === undefined ? "" : ` · ${inline(mutant.replacement)}`;

                undetected.push(`- ${mutant.status} · ${mutant.mutatorName} · \`${file}:${line}:${column}\`${replacement}`);
            }
        }
    }

    const scoreText = typeof report === "string" ? "none" : score(counts);
    const scope = area === "" ? "full" : "files";
    const lines = [
        `<!-- mutation-record head=${head || "unknown"} clean=${clean} scope=${scope} exit=${run.exitCode} score=${scoreText} -->`,
        "## `make mutation` run record",
        "",
        `- head: ${head === "" ? "unknown, git on the host did not answer" : `\`${head}\``}`,
        `- tree: ${tree[clean]}`,
        `- files: ${area === "" ? "not passed, the whole `src/`" : `\`${area}\``}`,
        `- started: ${run.startedAt.toISOString().replace(/\.\d+Z$/, "Z")} · duration: ${duration(run)} · exit code: ${run.exitCode}`,
    ];

    if (typeof report === "string") {
        lines.push(`- score: none — ${report}`);

        return lines.join("\n") + "\n";
    }

    const known = STATUSES.map((status) => `${status} ${counts.get(status) ?? 0}`);
    const unknown = [...counts].filter(([status]) => !STATUSES.includes(status)).map(([status, n]) => `${status} ${n}`);

    lines.push(
        `- score (Final mutation score): ${scoreText}`,
        `- statuses: ${[...known, ...unknown].join(" · ")}`,
        "",
        `<details><summary>Mutated files: ${files.length}</summary>`,
        "",
        "```text",
        ...files.map(([file]) => file),
        "```",
        "",
        "</details>",
        "",
        `### Survived and uncovered: ${undetected.length}`,
        "",
    );

    let length = lines.join("\n").length;

    for (const [index, line] of undetected.entries()) {
        if (length + line.length + 1 > RECORD_LIMIT) {
            lines.push(
                `- …and ${undetected.length - index} more: they did not fit into the record, the full list is in ` +
                    `\`reports/mutation/mutation.html\` on the machine of the run`,
            );
            break;
        }

        lines.push(line);
        length += line.length + 1;
    }

    return lines.join("\n") + "\n";
}

// The old files are removed before the run: a run that breaks off will leave none of its own, and the
// old ones would pass themselves off as its result — both the record and the reports it points to.
rmSync(REPORT_FILE, { force: true });
rmSync(HTML_FILE, { force: true });
rmSync(RECORD_FILE, { force: true });

const startedAt = new Date();
let finished = false;

function finish(exitCode: number): void {
    if (finished) {
        return;
    }

    finished = true;

    // A failure to write the record does not replace the outcome of the run: the review gate decides
    // ok or fail by the exit code.
    try {
        mkdirSync("reports/mutation", { recursive: true });
        writeFileSync(RECORD_FILE, record({ exitCode, startedAt, finishedAt: new Date() }));
        process.stdout.write(`\nRun record — ${RECORD_FILE}\n`);
    } catch (error) {
        process.stderr.write(`\nThe run record was not written: ${(error as Error).stack ?? String(error)}\n`);
    }

    // Not process.exit: output into a pipe goes asynchronously and would be cut off together with the
    // process. The wrapper has no open descriptors of its own, it waited for one process.
    process.exitCode = exitCode;
}

// spawn, not ProcessHelper from app/shared/process: that one accumulates the output in memory and
// treats a non-zero code as a refusal. Here the live output of Stryker over 15 minutes is needed, and
// its exit code is a regular outcome. The invariant about external processes
// (docs/architecture/invariants.md) holds: the arguments are an array, and there is no shell in the
// chain.
const child = spawn("npm", ["run", "mutation"], { stdio: "inherit" });

// npm did not start — a close after an error does not always arrive, and the old record is already
// deleted.
child.on("error", (error) => {
    process.stderr.write(`\nnpm run mutation did not start: ${error.message}\n`);
    finish(1);
});

// The exit code of npm, not of Stryker: when Stryker itself dies from a signal, npm returns an ordinary
// non-zero code.
child.on("close", (code, signal) => finish(code ?? 128 + (signal === null ? 0 : constants.signals[signal])));
