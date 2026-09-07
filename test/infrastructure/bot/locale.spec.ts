import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { FileHelper } from "app/helper/file-helper/file-helper";
import { createFluent, localeFromFilePath, resolveLocale } from "app/infrastructure/bot/locale";
import { DEFAULT_LOCALE, Locale, LOCALES } from "app/infrastructure/bot/locale.types";
import { MissingLocaleBundle, UnknownLocale } from "app/infrastructure/bot/locale.errors";

const localeDir = path.join(process.cwd(), "src", "infrastructure", "bot");

// Ключ верхнего уровня или терм: в начале строки, без отступа.
const MESSAGE_LINE = /^(-?[a-zA-Z][\w-]*) *=/;
// Атрибут: с отступом и точкой перед именем. Отступ без точки — продолжение значения.
const ATTRIBUTE_LINE = /^\s+\.([a-zA-Z][\w-]*) *=/;

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
