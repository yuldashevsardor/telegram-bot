// Wired in through NODE_OPTIONS in the mutation npm script and living only in the processes of
// Stryker; the mocha of make test and make check does not see it.
//
// @stryker-mutator/mocha-runner 10.0.0 reaches the internals of mocha through a require without
// an extension (lib/cli/run-helpers, lib/cli/options, lib/cli/collect-files), and in mocha 12.0.0
// those files are renamed to .cjs. The extensions for such a require Node takes from the keys of
// Module._extensions (Module._findPath), and there are only .js, .json and .node there, so the
// runner does not load: 'Cannot find TestRunner plugin "mocha"'. A .cjs key with the .js loader
// brings the files back into the lookup; the "type": "module" of the mocha package is no
// obstacle: the .js loader reads a .cjs as commonjs by its extension, without looking into
// package.json.
//
// To be removed together with the NODE_OPTIONS in the script once a runner with
// https://github.com/stryker-mutator/stryker-js/pull/6205 is released.
const Module = require("module");

if (!Module._extensions[".cjs"]) {
    Module._extensions[".cjs"] = Module._extensions[".js"];
}
