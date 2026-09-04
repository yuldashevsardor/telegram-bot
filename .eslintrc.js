module.exports = {
    parser: "@typescript-eslint/parser",
    plugins: ["@typescript-eslint", "prettier", "eslint-plugin-import"],
    extends: ["eslint:recommended", "prettier", "plugin:@typescript-eslint/recommended"],
    rules: {
        // Overwrite rules specified from the extended configs e.g.
        "@typescript-eslint/explicit-function-return-type": "warn",
        "@typescript-eslint/explicit-module-boundary-types": "warn",
        "@typescript-eslint/no-empty-interface": "off",
        "@typescript-eslint/ban-ts-comment": "warn",
        // Паттерн ^_ повторяет поведение noUnusedParameters: параметр, который нужен
        // по сигнатуре, но не используется, помечается подчёркиванием.
        "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
        "@typescript-eslint/no-empty-function": "off",

        "no-console": "off",
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
            // Ассерты chai — выражения без вызова: `expect(x).to.be.true`.
            files: ["test/**/*.ts"],
            rules: {
                "@typescript-eslint/no-unused-expressions": "off",
            },
        },
    ],
};
