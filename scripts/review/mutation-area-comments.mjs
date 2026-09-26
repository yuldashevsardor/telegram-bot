// Compares two versions of each changed .ts for scripts/review/mutation_area.py: whether their code
// is the same once the comments are set aside, and, when it is, the comments of each version. The
// input is a JSON object on stdin, {path: {old, new}}; the answer is one line of JSON,
// {path: {same, old, new}}, where old and new are [anchor, text, reach] triples: the anchor is the
// index of the token the comment stands before, and the reach lists the tokens on the line the
// comment starts on and on the line of its anchor. Which comment is a tool directive is decided in
// Python.
//
// The reach is there because a directive acts by line, not by token. `// Stryker disable
// next-line` silences the mutants on the line of the node it leads, and `// @ts-expect-error` the
// errors on the next line of code. A comment with a line break put inside that line moves part of
// its code out of the directive's reach, with the tokens and the anchor unchanged.
//
// It runs in the application container, where typescript is, and reaches it as the argument of
// `node -e`: stdin carries the file versions (mutation-area-configs.mjs says why a script cannot
// be read from scripts/ in the container).
//
// The versions are compared by the syntax tree, not by tokens. A bare scanner does not know where a
// template literal resumes after `${…}` or where a regular expression starts, and would take
// `// …` inside such a string for a comment. And a comment with a line break in it can move where
// a semicolon is inserted: `return /*\n*/ value` returns nothing, with the same tokens as
// `return /* */ value`.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "noop.js"));
const ts = require("typescript");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const files = JSON.parse(Buffer.concat(chunks).toString("utf8"));

const isJSDoc = (node) =>
    node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

function read(text) {
    const source = ts.createSourceFile(
        "file.ts",
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    // The kinds of the nodes in pre-order with the text of every token: the tree without trivia.
    const shape = [];
    const starts = [];
    const gaps = [];
    const visit = (node) => {
        // A JSDoc block is parsed into nodes of its own, but it is a comment like any other.
        const children = node.getChildren(source).filter((child) => !isJSDoc(child));
        if (children.length === 0) {
            shape.push(`${node.kind} ${node.getText(source)}`);
            starts.push(node.getStart(source));
            gaps.push(node.pos, node.end);
            return;
        }
        shape.push(`(${node.kind}`);
        children.forEach(visit);
        shape.push(")");
    };
    visit(source);

    const ranges = new Map();
    for (const gap of gaps) {
        for (const range of [
            ...(ts.getLeadingCommentRanges(text, gap) ?? []),
            ...(ts.getTrailingCommentRanges(text, gap) ?? []),
        ]) {
            ranges.set(range.pos, range);
        }
    }
    // The trivia between two tokens runs from the end of one to the start of the next, and either
    // side may own a comment in it: both are asked, and a comment found twice is kept once.
    const line = (position) => source.getLineAndCharacterOfPosition(position).line;
    const lines = starts.map(line);
    const comments = [...ranges.values()]
        .sort((a, b) => a.pos - b.pos)
        .map((range) => {
            const anchor = starts.findIndex((start) => start >= range.end);
            const own = [line(range.pos), lines[anchor]];
            const reach = lines.flatMap((at, index) => (own.includes(at) ? [index] : []));
            return [anchor, text.slice(range.pos, range.end), reach];
        });
    const broken = source.parseDiagnostics?.length > 0;
    return { shape: JSON.stringify(shape), comments, broken };
}

const answer = {};
for (const [file, versions] of Object.entries(files)) {
    const before = read(versions.old);
    const after = read(versions.new);
    // A version the parser cannot read has no tree to compare, and the file counts as code.
    const same = !before.broken && !after.broken && before.shape === after.shape;
    answer[file] = same ? { same, old: before.comments, new: after.comments } : { same };
}
console.log(JSON.stringify(answer));
