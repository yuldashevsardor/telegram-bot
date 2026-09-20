// Обёртка make mutation: гоняет npm run mutation и при любом его исходе пишет запись прогона. Формат
// и зачем запись нужна — docs/architecture/testing.md, «Запись прогона». Head и чистоту дерева
// передаёт хост (цель mutation в Makefile): .git в контейнер не смонтирован.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";

// Путь по умолчанию у репортёра json из stryker.config.mjs.
const REPORT_FILE = "reports/mutation/mutation.json";
const HTML_FILE = "reports/mutation/mutation.html";
const RECORD_FILE = "reports/mutation/record.md";
// Запись уходит в PR комментарием, а он вмещает 65 536 символов; запас — под подпись публикующего.
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
            return "Stryker не записал отчёт, прогон оборвался раньше";
        }

        return `отчёт не прочитан: ${(error as Error).message}`;
    }
}

// Та же формула, что у mutationScore в mutation-testing-metrics, по которому Stryker печатает
// Final mutation score: ошибки, заглушённые и неисполненные мутанты в счёт не идут, а без единого
// мутанта в счёте он NaN.
function score(counts: Map<string, number>): string {
    const count = (status: string): number => counts.get(status) ?? 0;
    const detected = count("Killed") + count("Timeout");
    const valid = detected + count("Survived") + count("NoCoverage");

    return valid > 0 ? ((detected / valid) * 100).toFixed(2) : "NaN";
}

function duration(run: Run): string {
    const seconds = Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000);

    return seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${seconds % 60} с`;
}

// Замена бывает многострочной и сама содержит обратные кавычки (мутант шаблонной строки). Разметка
// требует обрамления длиннее самой длинной цепочки кавычек внутри, иначе строка выжившего с ``
// закрывает код раньше времени и мутатор с местом уезжают в прозу.
function inline(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    const short = line.length > 80 ? `${line.slice(0, 80)}…` : line;
    const longest = [...short.matchAll(/`+/g)].reduce((max, [run]) => Math.max(max, run.length), 0);
    const fence = "`".repeat(longest + 1);

    return longest === 0 ? `${fence}${short}${fence}` : `${fence} ${short} ${fence}`;
}

function record(run: Run): string {
    const head = process.env["MUTATION_HEAD"] ?? "";
    // Число путей или что угодно ещё: рецепт цели пишет сюда unknown, когда git не ответил, а
    // Number("") — это 0, то есть «чисто» на дереве, которого никто не смотрел.
    const counted = process.env["MUTATION_DIRTY"] ?? "";
    const dirty = /^\d+$/.test(counted) ? Number(counted) : Number.NaN;
    const area = process.env["MUTATE"] ?? "";
    const report = readReport();
    const clean = head === "" || Number.isNaN(dirty) ? "unknown" : dirty === 0 ? "yes" : "no";
    const tree = { yes: "чистое", no: `грязное, путей в \`git status --porcelain\`: ${dirty}`, unknown: "неизвестно" };
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
        "## Запись прогона `make mutation`",
        "",
        `- head: ${head === "" ? "неизвестен, git на хосте не ответил" : `\`${head}\``}`,
        `- дерево: ${tree[clean]}`,
        `- files: ${area === "" ? "не передан, весь `src/`" : `\`${area}\``}`,
        `- начало: ${run.startedAt.toISOString().replace(/\.\d+Z$/, "Z")} · длительность: ${duration(run)} · код выхода: ${run.exitCode}`,
    ];

    if (typeof report === "string") {
        lines.push(`- счёт: нет — ${report}`);

        return lines.join("\n") + "\n";
    }

    const known = STATUSES.map((status) => `${status} ${counts.get(status) ?? 0}`);
    const unknown = [...counts].filter(([status]) => !STATUSES.includes(status)).map(([status, n]) => `${status} ${n}`);

    lines.push(
        `- счёт (Final mutation score): ${scoreText}`,
        `- статусы: ${[...known, ...unknown].join(" · ")}`,
        "",
        `<details><summary>Мутированные файлы: ${files.length}</summary>`,
        "",
        "```text",
        ...files.map(([file]) => file),
        "```",
        "",
        "</details>",
        "",
        `### Выжившие и непокрытые: ${undetected.length}`,
        "",
    );

    let length = lines.join("\n").length;

    for (const [index, line] of undetected.entries()) {
        if (length + line.length + 1 > RECORD_LIMIT) {
            lines.push(
                `- …и ещё ${undetected.length - index}: в запись не поместились, полный список — в ` +
                    `\`reports/mutation/mutation.html\` на машине прогона`,
            );
            break;
        }

        lines.push(line);
        length += line.length + 1;
    }

    return lines.join("\n") + "\n";
}

// Старые файлы убираются до прогона: оборванный прогон своих не оставит, и старые выдали бы себя
// за его результат — и запись, и отчёты, на которые она ссылается.
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

    // Сбой записи не подменяет исход прогона: по коду выхода гейт ревью решает ok или fail.
    try {
        mkdirSync("reports/mutation", { recursive: true });
        writeFileSync(RECORD_FILE, record({ exitCode, startedAt, finishedAt: new Date() }));
        process.stdout.write(`\nЗапись прогона — ${RECORD_FILE}\n`);
    } catch (error) {
        process.stderr.write(`\nЗапись прогона не записана: ${(error as Error).stack ?? String(error)}\n`);
    }

    // Не process.exit: вывод в пайп уходит асинхронно и оборвался бы вместе с процессом. Своих
    // незакрытых дескрипторов у обёртки нет, она ждала один процесс.
    process.exitCode = exitCode;
}

// spawn, а не ProcessHelper из app/shared/process: тот копит вывод в памяти и считает ненулевой код
// отказом, а здесь нужен живой вывод Stryker на 15 минут и его код выхода как штатный исход.
// Инвариант про внешние процессы (docs/architecture/invariants.md) соблюдён: аргументы массивом,
// шелла в цепочке нет.
const child = spawn("npm", ["run", "mutation"], { stdio: "inherit" });

// npm не запустился — close после error приходит не всегда, а старая запись уже удалена.
child.on("error", (error) => {
    process.stderr.write(`\nnpm run mutation не запустился: ${error.message}\n`);
    finish(1);
});

// Код выхода npm, а не Stryker: умер по сигналу сам Stryker — npm отдаёт обычный ненулевой код.
child.on("close", (code, signal) => finish(code ?? 128 + (signal === null ? 0 : constants.signals[signal])));
