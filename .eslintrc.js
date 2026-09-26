module.exports = {
    parser: "@typescript-eslint/parser",
    plugins: ["@typescript-eslint", "prettier", "eslint-plugin-import"],
    extends: ["eslint:recommended", "prettier", "plugin:@typescript-eslint/recommended"],
    rules: {
        "@typescript-eslint/explicit-function-return-type": "warn",
        "@typescript-eslint/explicit-module-boundary-types": "warn",
        "@typescript-eslint/no-empty-interface": "off",
        "@typescript-eslint/ban-ts-comment": "warn",
        // The ^_ pattern repeats the behaviour of noUnusedParameters: a parameter that the
        // signature needs but the body does not use is marked with an underscore.
        "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
        "@typescript-eslint/no-empty-function": "off",
        // A separate `import type` line rather than an inline `import { type X }`: the import
        // line shows whether the module is needed at runtime. consistent-type-imports catches a
        // type brought in as a value but accepts an inline `type` as a mark, so
        // consistent-type-specifier-style holds the form. That rule also covers an import of
        // inline types alone, so @typescript-eslint/no-import-type-side-effects is off as a
        // duplicate.
        "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "separate-type-imports" }],
        "import/consistent-type-specifier-style": ["error", "prefer-top-level"],

        // Only Logger writes outwards: console.* bypasses the level, the requestId and the
        // LOGGER_LEVEL threshold, and in production the structured pino stream. The exceptions are
        // the ConsoleLogger adapter (below) and the fail() fallback in app.ts; the cases in which
        // it writes to the console are in docs/architecture/logging.md.
        "no-console": "error",
        "no-restricted-imports": [
            "error",
            {
                patterns: [".*"],
            },
        ],

        "import/no-relative-parent-imports": "error",
        "import/no-absolute-path": "error",
        "import/no-relative-packages": "error",
        "import/no-self-import": "error",
        "import/no-deprecated": "error",
        "import/first": "error",
        "import/exports-last": "error",
        "import/newline-after-import": "error",
    },
    overrides: [
        {
            // The chai assertions are expressions without a call: `expect(x).to.be.true`.
            files: ["test/**/*.ts"],
            rules: {
                "@typescript-eslint/no-unused-expressions": "off",
            },
        },
        {
            // The adapter of the Logger port: console.* is its implementation, not a way around
            // it. The spec of the adapter collects the entries by substituting console under the
            // same method names.
            files: ["src/platform/logger/console-logger.ts", "test/platform/logger/console-logger.spec.ts"],
            rules: {
                "no-console": "off",
            },
        },
        {
            // The migrations live outside src, where the app/* alias does not lead, and
            // node-pg-migrate loads them, not the build. So they import the shared shorthands by a
            // relative path.
            files: ["migrations/**/*.ts"],
            rules: {
                "no-restricted-imports": "off",
            },
        },
    ],
};
