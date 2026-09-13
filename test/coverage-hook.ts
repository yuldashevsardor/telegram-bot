import { readFileSync } from "fs";
import { dirname, resolve, sep } from "path";
import { buildSync } from "esbuild";
import { createInstrumenter } from "istanbul-lib-instrument";

// Хук прогона покрытия (npm run test:coverage): файлы src инструментируются в исходном
// TypeScript, до транспиляции. Вывод tsx для этого не годится: esbuild кладёт в него свои
// хелперы (__copyProps, __decorateClass, 0&&(module.exports=…)), и при переносе по source
// map istanbul приписывает их ветви строкам исходника. Транспилирует хук сам — tsx читает
// файл с диска, и инструментированный текст ему не передать.
//
// Отсюда нельзя импортировать app/*: модуль загрузился бы до установки хука и выпал бы
// из подсчёта.

type CompilableModule = NodeModule & { _compile(code: string, filename: string): void };

// Что из src попадёт в отчёт, решают include и exclude nyc: лишнее он отбросит при записи.
const SRC_DIR = resolve("src") + sep;
const TSCONFIG = resolve(process.env["TSX_TSCONFIG_PATH"] ?? "tsconfig.json");

// Плагины разбора — из конфига, который nyc передаёт дочернему процессу: так файлы,
// загруженные тестами, и незагруженные (режим all) разбираются одинаково. Без nyc плагина
// typescript не будет, и разбор упадёт на первой же аннотации типа.
const { parserPlugins = [] } = JSON.parse(process.env["NYC_CONFIG"] ?? "{}") as { parserPlugins?: string[] };
const instrumenter = createInstrumenter({ esModules: true, produceSourceMap: true, parserPlugins });

function compileInstrumented(module: CompilableModule, filename: string): void {
    const instrumented = instrumenter.instrumentSync(readFileSync(filename, "utf8"), filename);
    // Карту istanbul esbuild сшивает со своей: иначе стек упавшего теста указывал бы на
    // строки инструментированного текста, а не исходника.
    const map = Buffer.from(JSON.stringify(instrumenter.lastSourceMap())).toString("base64");
    // Опции, от которых зависит поведение кода, повторяют tsx, tsconfig — тот же, что у него
    // через TSX_TSCONFIG_PATH. Рабочий
    // каталог — каталог файла: пути в карте esbuild пишет от него, а Node разрешает их от
    // каталога модуля, и с корнем проекта путь в стеке задвоился бы.
    const [output] = buildSync({
        stdin: {
            contents: `${instrumented}\n//# sourceMappingURL=data:application/json;base64,${map}`,
            loader: "ts",
            sourcefile: filename,
        },
        absWorkingDir: dirname(filename),
        tsconfig: TSCONFIG,
        write: false,
        format: "cjs",
        platform: "node",
        target: `node${process.versions.node}`,
        keepNames: true,
        sourcemap: "inline",
    }).outputFiles;

    module._compile(output?.text ?? "", filename);
}

// Сам этот файл загружен через tsx, поэтому его загрузчик .ts к этому моменту уже стоит.
const tsxLoader = require.extensions[".ts"];

require.extensions[".ts"] = (module, filename): void => {
    if (filename.startsWith(SRC_DIR)) {
        compileInstrumented(module as CompilableModule, filename);
    } else {
        tsxLoader?.(module, filename);
    }
};
