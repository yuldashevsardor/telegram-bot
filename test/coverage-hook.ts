import { readFileSync } from "fs";
import { dirname, resolve, sep } from "path";
import { buildSync } from "esbuild";
import { createInstrumenter } from "istanbul-lib-instrument";

// The hook of npm run test:coverage: it instruments the files of src in their source TypeScript,
// before transpilation. Why not the tsx output — docs/architecture/testing.md, "Coverage". The hook
// transpiles by itself because tsx reads the file from disk and cannot be handed the instrumented
// text.
//
// Nothing from app/* may be imported here: that module would load before the hook is installed and
// drop out of the count.

type CompilableModule = NodeModule & { _compile(code: string, filename: string): void };

// What of src makes it into the report is decided by the include and exclude of nyc: it drops the
// rest when writing.
const SRC_DIR = resolve("src") + sep;
const TSCONFIG = resolve(process.env["TSX_TSCONFIG_PATH"] ?? "tsconfig.json");

// The parser plugins come from the config nyc passes to the child process, so the files the tests
// load and the ones they do not (the all mode) are parsed alike. Without nyc there is no typescript
// plugin, and parsing fails on the very first type annotation.
const { parserPlugins = [] } = JSON.parse(process.env["NYC_CONFIG"] ?? "{}") as { parserPlugins?: string[] };
const instrumenter = createInstrumenter({ esModules: true, produceSourceMap: true, parserPlugins });

function compileInstrumented(module: CompilableModule, filename: string): void {
    const instrumented = instrumenter.instrumentSync(readFileSync(filename, "utf8"), filename);
    // esbuild stitches the istanbul map together with its own: otherwise the stack of a failed
    // test would point at the lines of the instrumented text rather than of the source.
    const map = Buffer.from(JSON.stringify(instrumenter.lastSourceMap())).toString("base64");
    // The options the behaviour of the code depends on repeat tsx, with the tsconfig tsx gets through
    // TSX_TSCONFIG_PATH. The working directory is the directory of the file: esbuild writes the paths
    // of the map relative to it, and Node resolves them relative to the directory of the module. With
    // the project root the path in the stack would be doubled.
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

// This file is itself loaded through tsx, so by this moment its .ts loader is already in place.
const tsxLoader = require.extensions[".ts"];

require.extensions[".ts"] = (module, filename): void => {
    if (filename.startsWith(SRC_DIR)) {
        compileInstrumented(module as CompilableModule, filename);
    } else {
        tsxLoader?.(module, filename);
    }
};
