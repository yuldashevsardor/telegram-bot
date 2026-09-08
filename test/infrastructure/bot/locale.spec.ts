import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { FileHelper } from "app/helper/file-helper/file-helper";
import { Fluent } from "@moebius/fluent";
import { Context } from "app/infrastructure/bot/bot.types";
import { createFluent, createFluentMiddleware, localeFromFilePath, resolveLocale } from "app/infrastructure/bot/locale";
import { DEFAULT_LOCALE, Locale, LOCALES } from "app/infrastructure/bot/locale.types";
import { MissingLocaleBundle, UnknownLocale } from "app/infrastructure/bot/locale.errors";

const localeDir = path.join(process.cwd(), "src", "infrastructure", "bot");

// Ключ верхнего уровня или терм: в начале строки, без отступа.
const MESSAGE_LINE = /^(-?[a-zA-Z][\w-]*) *=/;
// Атрибут: с отступом и точкой перед именем. Отступ без точки — продолжение значения.
const ATTRIBUTE_LINE = /^\s+\.([a-zA-Z][\w-]*) *=/;

// Как ключ попадает в код: ctx.t("key") и descriptionKey команды.
const TRANSLATE_CALL = /\.t\("([^"]+)"/g;
const DESCRIPTION_KEY = /descriptionKey[^=]*= *"([^"]+)"/g;

describe("Fluent locales", function () {
    let filesByLocale: Map<Locale, string[]>;

    before(async function () {
        const files = await FileHelper.findFilesByExtensions(localeDir, [".ftl"]);

        filesByLocale = new Map(LOCALES.map((locale) => [locale, []]));

        for (const filePath of files) {
            filesByLocale.get(localeFromFilePath(filePath))?.push(filePath);
        }
    });

    it("names every file so that its locale is known", async function () {
        const files = await FileHelper.findFilesByExtensions(localeDir, [".ftl"]);

        expect(files).to.not.be.empty;

        for (const filePath of files) {
            expect(() => localeFromFilePath(filePath), filePath).to.not.throw();
        }
    });

    it("has at least one file per supported locale", function () {
        for (const locale of LOCALES) {
            expect(filesByLocale.get(locale), locale).to.not.be.empty;
        }
    });

    // Fluent на отсутствующем ключе откатывается в дефолтный бандл, поэтому расхождение
    // не падает, а тихо отдаёт пользователю чужой язык.
    it("declares the same keys in every locale", async function () {
        const keysByLocale = new Map<Locale, Set<string>>();

        for (const [locale, files] of filesByLocale) {
            keysByLocale.set(locale, await readKeys(files));
        }

        const expectedKeys = keysByLocale.get(DEFAULT_LOCALE) ?? new Set<string>();

        for (const [locale, keys] of keysByLocale) {
            if (locale === DEFAULT_LOCALE) {
                continue;
            }

            expect([...keys].sort(), `keys of "${locale}"`).to.deep.equal([...expectedKeys].sort());
        }
    });
});

// Ключ в коде — обычная строка, компилятор её с бандлом не связывает, а Fluent на
// ненайденном ключе возвращает "{ключ}" и молча отдаёт его пользователю.
describe("Fluent keys used in the code", function () {
    it("declares every key the code asks for", async function () {
        const sources = await FileHelper.findFilesByExtensions(localeDir, [".ts"]);
        const usedKeys = new Set<string>();

        for (const filePath of sources) {
            const source = await fs.readFile(filePath, "utf8");

            for (const match of source.matchAll(TRANSLATE_CALL)) {
                if (match[1]) {
                    usedKeys.add(match[1]);
                }
            }

            for (const match of source.matchAll(DESCRIPTION_KEY)) {
                if (match[1]) {
                    usedKeys.add(match[1]);
                }
            }
        }

        expect(usedKeys).to.not.be.empty;

        const files = await FileHelper.findFilesByExtensions(localeDir, [".ftl"]);
        const declaredKeys = await readKeys(files.filter((filePath) => localeFromFilePath(filePath) === DEFAULT_LOCALE));

        expect([...usedKeys].filter((key) => !declaredKeys.has(key))).to.be.empty;
    });
});

describe("localeFromFilePath", function () {
    it("takes the locale from the second to last name segment", function () {
        expect(localeFromFilePath("/app/src/start.conversation.locale.en.ftl")).to.equal("en");
    });

    it("rejects a name whose locale is not supported", function () {
        expect(() => localeFromFilePath("/app/src/start.conversation.locale.de.ftl")).to.throw(UnknownLocale);
    });
});

describe("resolveLocale", function () {
    it("keeps a supported language", function () {
        expect(resolveLocale("en")).to.equal("en");
    });

    it("drops the region of an IETF tag", function () {
        expect(resolveLocale("en-US")).to.equal("en");
        expect(resolveLocale("RU-RU")).to.equal("ru");
    });

    it("falls back to the default locale", function () {
        expect(resolveLocale("de")).to.equal(DEFAULT_LOCALE);
        expect(resolveLocale(undefined)).to.equal(DEFAULT_LOCALE);
        expect(resolveLocale("")).to.equal(DEFAULT_LOCALE);
    });
});

async function readKeys(filePaths: string[]): Promise<Set<string>> {
    const keys = new Set<string>();

    for (const filePath of filePaths) {
        const source = await fs.readFile(filePath, "utf8");
        let messageId = "";

        for (const line of source.split("\n")) {
            const message = MESSAGE_LINE.exec(line);

            if (message?.[1]) {
                messageId = message[1];
                keys.add(messageId);

                continue;
            }

            const attribute = ATTRIBUTE_LINE.exec(line);

            if (attribute?.[1] && messageId) {
                keys.add(`${messageId}.${attribute[1]}`);
            }
        }
    }

    return keys;
}

describe("createFluent", function () {
    let localeDir: string;

    beforeEach(async function () {
        localeDir = await fs.mkdtemp(path.join(os.tmpdir(), "locale-"));
    });

    afterEach(async function () {
        await fs.rm(localeDir, { recursive: true, force: true });
    });

    it("loads a bundle per locale", async function () {
        await writeLocaleFile("ru", "greeting = Привет");
        await writeLocaleFile("en", "greeting = Hello");

        const fluent = await createFluent(localeDir);

        expect(fluent.translate("ru", "greeting")).to.equal("Привет");
        expect(fluent.translate("en", "greeting")).to.equal("Hello");
    });

    // Изоляция подстановок выключена намеренно (см. createFluent), а по умолчанию она
    // включена — иначе в тексте появились бы невидимые U+2068/U+2069 вокруг значения.
    it("puts a placeable into the text as is", async function () {
        await writeLocaleFile("ru", "result = Готово: {$path}");
        await writeLocaleFile("en", "result = Done: {$path}");

        const fluent = await createFluent(localeDir);

        expect(fluent.translate("ru", "result", { path: "/tmp/font.eot" })).to.equal("Готово: /tmp/font.eot");
    });

    // Ради этого дефолтным помечается ровно один бандл: иначе им стал бы последний
    // добавленный, и текст на нехватающем ключе зависел бы от порядка обхода каталогов.
    it("falls back to the default locale on a key the locale is missing", async function () {
        await writeLocaleFile("ru", "greeting = Привет\nonly-in-default = Только в дефолте");
        await writeLocaleFile("en", "greeting = Hello");

        const fluent = await createFluent(localeDir);

        expect(fluent.translate("en", "only-in-default")).to.equal("Только в дефолте");
    });

    it("rejects a locale without a single file", async function () {
        await writeLocaleFile(DEFAULT_LOCALE, "greeting = Привет");

        await expectRejection(createFluent(localeDir), MissingLocaleBundle);
    });

    it("rejects a file named with an unsupported locale", async function () {
        for (const locale of LOCALES) {
            await writeLocaleFile(locale, "greeting = Hello");
        }
        await writeLocaleFile("de", "greeting = Hallo");

        await expectRejection(createFluent(localeDir), UnknownLocale);
    });

    async function writeLocaleFile(locale: string, source: string): Promise<void> {
        await fs.writeFile(path.join(localeDir, `test.locale.${locale}.ftl`), `${source}\n`);
    }

    async function expectRejection(promise: Promise<unknown>, expected: new (...params: never[]) => Error): Promise<void> {
        try {
            await promise;
            expect.fail(`expected ${expected.name}`);
        } catch (error) {
            expect(error).to.be.instanceOf(expected);
        }
    }
});

describe("createFluentMiddleware", function () {
    let localeDir: string;
    let fluent: Fluent;

    beforeEach(async function () {
        localeDir = await fs.mkdtemp(path.join(os.tmpdir(), "locale-"));

        for (const locale of LOCALES) {
            await fs.writeFile(path.join(localeDir, `test.locale.${locale}.ftl`), `greeting = ${locale}\n`);
        }

        fluent = await createFluent(localeDir);
    });

    afterEach(async function () {
        await fs.rm(localeDir, { recursive: true, force: true });
    });

    it("translates into the locale of the update", async function () {
        const ctx = await runMiddleware("en");

        expect(ctx.t("greeting")).to.equal("en");
    });

    // Плагин разговоров пишет в op-лог, а оттуда в сессию, все перечислимые свойства
    // контекста, кроме интринсивных. `fluent` уехал бы туда целиком и вернулся с пустыми
    // бандлами; `t`/`translate` он восстанавливает биндом от живого контекста.
    it("keeps ctx.fluent out of the enumerable properties", async function () {
        const ctx = await runMiddleware("ru");

        expect(Object.keys(ctx)).to.not.include("fluent");
        expect(Object.keys(ctx)).to.include.members(["t", "translate"]);
        expect(ctx.fluent.instance).to.equal(fluent);
    });

    async function runMiddleware(languageCode: string): Promise<Context> {
        const ctx = { from: { language_code: languageCode } } as unknown as Context;

        await createFluentMiddleware(fluent)(ctx, () => Promise.resolve());

        return ctx;
    }
});
