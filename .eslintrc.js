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
        // Отдельная строка `import type`, а не инлайн `import { type X }`: по строке импорта
        // видно, нужен ли модуль в рантайме. no-import-type-side-effects сворачивает
        // импорт из одних инлайн-типов в ту же форму.
        "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "separate-type-imports" }],
        "@typescript-eslint/no-import-type-side-effects": "error",

        // Наружу пишет только Logger: console.* минует уровень, requestId и порог
        // LOGGER_LEVEL, а на проде — структурный поток pino. Исключения — адаптер
        // ConsoleLogger (ниже) и фолбэк fail() в app.ts до появления контекста.
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
            // Ассерты chai — выражения без вызова: `expect(x).to.be.true`.
            files: ["test/**/*.ts"],
            rules: {
                "@typescript-eslint/no-unused-expressions": "off",
            },
        },
        {
            // Адаптер порта Logger: console.* — его реализация, а не обход. Тест
            // адаптера снимает записи подменой console по тем же именам методов.
            files: ["src/platform/logger/console-logger.ts", "test/platform/logger/console-logger.spec.ts"],
            rules: {
                "no-console": "off",
            },
        },
        {
            // Миграции живут вне src, алиас app/* туда не ведёт, и грузит их не сборка,
            // а node-pg-migrate — общие shorthands подключаются относительным путём.
            files: ["migrations/**/*.ts"],
            rules: {
                "no-restricted-imports": "off",
            },
        },
        {
            // Правило «Domain не зависит от grammY, PostgreSQL и pino» (CLAUDE.md, «Стиль»)
            // до сих пор держалось только договорённостью. Запрет относительных импортов в
            // списке повторён намеренно: overrides заменяет конфигурацию правила целиком, а
            // не дополняет общую, и без ".*" внутри домена они снова стали бы разрешены.
            // shared/ в заборе потому, что домен импортирует из него ошибки, FileHelper,
            // ProcessHelper и configValue: запрещённый пакет там дошёл бы до домена транзитивно.
            files: ["src/font-convertor/**/*.ts", "src/shared/**/*.ts"],
            rules: {
                "no-restricted-imports": [
                    "error",
                    {
                        patterns: [".*", "grammy", "grammy/*", "@grammyjs/*", "@moebius/*", "postgres", "pg", "pino"],
                    },
                ],
            },
        },
    ],
};
