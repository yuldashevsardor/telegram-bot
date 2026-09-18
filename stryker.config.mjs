import { globSync } from "node:fs";

// Мутационное тестирование, запуск — make mutation. Почему настроено так и как разбирать
// выживших мутантов — docs/architecture/testing.md, «Мутационное тестирование».

// Спеки, которым нужна база. Stryker гоняет спеки без test/database-hook.ts, поэтому они
// исключены: без хука они падают на чтении TEST_DATABASE_NAME, и новая такая спека уронит
// первый прогон Stryker, пока её не впишут сюда. Найти их —
// grep -rln testDatabaseName test --include='*.spec.ts'.
const DATABASE_SPECS = [
    "test/platform/database/database.spec.ts",
    "test/telegram/session/pgsql-storage.spec.ts",
    "test/telegram/user/pgsql-user-repository.spec.ts",
];

// Код, поведение которого проверяют только спеки выше. Без них его мутанты выживали бы и
// оставались непокрытыми не потому, что тесты слабые, а потому, что тесты не запущены.
const DATABASE_ONLY_SOURCES = [
    "src/platform/database/database.ts",
    "src/telegram/session/pgsql-storage.ts",
    "src/telegram/user/pgsql-user-repository.ts",
];

// Область make mutation files="…": глобы через пробел или перенос строки, как у make lint.
// Запятая не разделитель: она часть глоба src/{shared,telegram}/**. Приходит переменной, а не
// флагом --mutate, потому что флаг заменил бы список целиком вместе с исключениями ниже.
const area = (process.env.MUTATE ?? "").split(/\s+/).filter((pattern) => pattern !== "");
// Область из одних исключений («всё, кроме конвертора») вычитается из всего src/: без
// положительного глоба Stryker не нашёл бы ни одного файла и молча завершился успехом.
const base = area.some((pattern) => !pattern.startsWith("!")) ? [] : ["src/**/*.ts"];

// Положительный глоб, который не нашёл ни одного .ts в src/, — опечатка, каталог без глоба
// (src/shared вместо src/shared/**) или файл не из src/. Stryker на нём только предупредил бы и
// завершился успехом с пустой таблицей, поэтому прогон останавливается здесь. Хвост :10-20 —
// диапазон строк Stryker, его glob не понимает.
for (const pattern of area.filter((pattern) => !pattern.startsWith("!"))) {
    const files = globSync(pattern.replace(/:\d+(:\d+)?-\d+(:\d+)?$/, ""));

    if (!files.some((file) => file.startsWith("src/") && file.endsWith(".ts"))) {
        console.error(
            `make mutation: files="${pattern}" не находит ни одного .ts в src/ — нужен глоб до файлов, например src/shared/**`,
        );
        process.exit(1);
    }
}

export default {
    testRunner: "mocha",
    // all, а не perTest: perTest приписывает код из before/after последнему тесту перед хуком и
    // гоняет на мутанта этот чужой тест — такой мутант ложно выживает. Цена — прогон в
    // несколько раз дольше (docs/architecture/testing.md, «Мутационное тестирование»).
    coverageAnalysis: "all",
    mutate: [
        ...base,
        ...area,
        // Точка входа на импорте поднимает Application, спека её не загружает — как exclude у nyc.
        "!src/app.ts",
        // Глоб области вроде src/telegram/** захватывает и локали, а .ftl Stryker разобрать не
        // может и падает: «No parser registered for .ftl».
        "!src/**/*.ftl",
        ...DATABASE_ONLY_SOURCES.map((file) => `!${file}`),
    ],
    mochaOptions: {
        // spec раннер берёт из .mocharc.json, а require из конфига заменяет целиком: здесь он
        // тот же, но без database-hook.ts.
        require: ["tsx/cjs"],
        ignore: DATABASE_SPECS,
    },
    // Значение по умолчанию, выписанное после замера при perTest: при 30 000 прогон шёл втрое
    // дольше, а статус сменили три мутанта из двухсот десяти — с Timeout на Killed, и оба
    // статуса значат «обнаружен».
    timeoutMS: 5000,
    // Порог здесь, а не в скилле ревью: его проверяет любой make mutation — и гейт ревью, и
    // прогон области у автора, как порог nyc в package.json проверяет любой test:coverage. 100, а
    // не 99: счёт — процент от мутантов области, и 99 на всём src/ пропускает два десятка
    // выживших, а на области из двадцати мутантов — ни одного. 100 значит «ни одного выжившего»
    // на области любой величины.
    thresholds: { break: 100 },
    reporters: ["clear-text", "progress", "html"],
    // Иначе clear-text печатает под таблицей все пятьсот с лишним тестов прогона.
    clearTextReporter: { reportTests: false },
    // Песочница копирует проект целиком; тома с временными файлами и отчётами ей не нужны.
    ignorePatterns: ["/tmp", "/coverage", "/reports"],
};
