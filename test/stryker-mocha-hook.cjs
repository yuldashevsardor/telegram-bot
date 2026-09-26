// Wired in through NODE_OPTIONS in the mutation npm script, so it lives only in the processes of
// Stryker; the mocha of make test and make check does not see it.
//
// @stryker-mutator/mocha-runner 10.0.0 requires the internals of mocha without an extension
// (lib/cli/run-helpers, lib/cli/options, lib/cli/collect-files), and mocha 12.0.0 renamed those
// files to .cjs. For such a require Node tries the keys of Module._extensions (Module._findPath):
// only .js, .json and .node. So the runner does not load: 'Cannot find TestRunner plugin "mocha"'.
// A .cjs key with the .js loader brings the files back into the lookup. The "type": "module" of
// the mocha package is no obstacle: the .js loader reads a .cjs as commonjs by its extension,
// without looking into package.json.
//
// To be removed together with the NODE_OPTIONS in the script once a runner with
// https://github.com/stryker-mutator/stryker-js/pull/6205 is released.
const Module = require("module");

if (!Module._extensions[".cjs"]) {
    Module._extensions[".cjs"] = Module._extensions[".js"];
}
