// Подключается через NODE_OPTIONS в npm-скрипте mutation и живёт только в процессах
// Stryker; mocha в make test и make check его не видит.
//
// @stryker-mutator/mocha-runner 10.0.0 достаёт внутренности mocha через require без
// расширения (lib/cli/run-helpers, lib/cli/options, lib/cli/collect-files), а в mocha
// 12.0.0 эти файлы переименованы в .cjs. Расширения для такого require Node берёт из
// ключей Module._extensions (Module._findPath), а там только .js, .json и .node, поэтому
// раннер не загружается: «Cannot find TestRunner plugin "mocha"». Ключ .cjs с загрузчиком
// .js возвращает файлы в перебор; "type": "module" пакета mocha не мешает: загрузчик .js
// читает .cjs как commonjs по расширению, не заглядывая в package.json.
//
// Удалить вместе с NODE_OPTIONS в скрипте, когда выйдет раннер с
// https://github.com/stryker-mutator/stryker-js/pull/6205.
const Module = require("module");

if (!Module._extensions[".cjs"]) {
    Module._extensions[".cjs"] = Module._extensions[".js"];
}
