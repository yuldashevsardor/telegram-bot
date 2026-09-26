// The configs of the mutation run as Stryker, mocha and tsc read them, printed as one line of JSON
// for scripts/review/mutation_area.py: the files the Stryker config excludes, the specs, the
// aliases of tsconfig.check.json.
//
// It runs in the application container, where those packages are, and reaches it on stdin: the
// container sees only the directories docker-compose.app.yml mounts, and scripts/ is not one of
// them, while the copy in the image is as old as the last make rebuild.
//
// The arguments are the changed .ts paths that change more than comments. The spec glob is
// matched against them as well as expanded over the tree: a deleted spec exists nowhere, and
// deleting a spec is the strongest way to weaken it. MUTATE is dropped because the config turns it into positive globs of `mutate`,
// while only the `!` entries are wanted.
import { globSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(path.join(process.cwd(), "noop.js"));
const changed = process.argv.slice(2);

delete process.env.MUTATE;
const { default: stryker } = await import(pathToFileURL("stryker.config.mjs").href);
const excluded = globSync(stryker.mutate.filter((p) => p.startsWith("!")).map((p) => p.slice(1)));

const specGlobs = require("mocha/lib/cli/options.cjs").loadOptions([])._;
const specs = [
    ...globSync(specGlobs),
    ...changed.filter((file) => specGlobs.some((glob) => path.matchesGlob(file, glob))),
];

const ts = require("typescript");
const message = (d) => ts.flattenDiagnosticMessageText(d.messageText, "\n");
const parsed = ts.getParsedCommandLineOfConfigFile("tsconfig.check.json", {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(message(d));
    },
});
if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(message).join("; "));
}
const base = parsed.options.pathsBasePath ?? parsed.options.baseUrl;
const aliases = [];
for (const [key, targets] of Object.entries(parsed.options.paths ?? {})) {
    if (!key.endsWith("*")) continue;
    for (const target of targets.filter((t) => t.endsWith("*"))) {
        const dir = path.relative(process.cwd(), path.resolve(base, target.slice(0, -1)));
        aliases.push({ prefix: key.slice(0, -1), dir: dir + "/" });
    }
}

console.log(JSON.stringify({ excluded, specs, aliases }));
