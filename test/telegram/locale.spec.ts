import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { FileHelper } from "app/shared/fs/file-helper";
import type { Fluent } from "@moebius/fluent";
import type { Context } from "app/telegram/bot/bot.types";
import { createFluent, createFluentMiddleware, localeFromFilePath, resolveLocale } from "app/telegram/locale/locale";
import type { Locale } from "app/telegram/locale/locale.types";
import { DEFAULT_LOCALE, LOCALES } from "app/telegram/locale/locale.types";
import { MissingLocaleBundle, UnknownLocale } from "app/telegram/locale/locale.errors";

const localeDir = path.join(process.cwd(), "src", "telegram");

// A top-level key or a term: at the start of the line, no indent.
const MESSAGE_LINE = /^(-?[a-zA-Z][\w-]*) *=/;
// An attribute: indented and with a dot before the name. An indent without a dot is a
// continuation of the value.
const ATTRIBUTE_LINE = /^\s+\.([a-zA-Z][\w-]*) *=/;

// How a key gets into the code: ctx.t("key") and a command's descriptionKey. The parsing is
// crude, over the text of the source: a key assembled from anything but a string literal
// will not get here. Both expressions are held to a single line — a class that lets a
// newline through drags the match to the first assignment further down the file and
// substitutes a foreign line as the key.
const TRANSLATE_CALL = /\.t\("([^"]+)"/g;
const DESCRIPTION_KEY = /descriptionKey[^=\n]*= *"([^"]+)"/g;

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

    // On a missing key Fluent falls back to the default bundle, so a divergence does not
    // fail but silently hands the user a foreign language.
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

// A key in the code is an ordinary string, the compiler does not tie it to a bundle, and on
// a key it cannot find Fluent returns "{key}" and silently hands it to the user.
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
        const filePath = "/app/src/start.conversation.locale.de.ftl";

        expect(() => localeFromFilePath(filePath))
            .to.throw(UnknownLocale, /^Unknown locale "de" in translation file name\.$/)
            .with.property("payload")
            .that.deep.equals({ path: filePath, locale: "de" });
    });

    it("rejects a name without the locale segment", function () {
        const filePath = "/app/src/ftl";

        expect(() => localeFromFilePath(filePath))
            .to.throw(UnknownLocale, /^Unknown locale "" in translation file name\.$/)
            .with.property("payload")
            .that.deep.equals({ path: filePath, locale: "" });
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
        await writeLocaleFile("ru", "greeting = Hi");
        await writeLocaleFile("en", "greeting = Hello");

        const fluent = await createFluent(localeDir);

        expect(fluent.translate("ru", "greeting")).to.equal("Hi");
        expect(fluent.translate("en", "greeting")).to.equal("Hello");
    });

    // Placeable isolation is off on purpose (see createFluent), while by default it is on —
    // otherwise invisible U+2068/U+2069 would appear in the text around the value.
    it("puts a placeable into the text as is", async function () {
        await writeLocaleFile("ru", "result = Ready: {$path}");
        await writeLocaleFile("en", "result = Done: {$path}");

        const fluent = await createFluent(localeDir);

        expect(fluent.translate("ru", "result", { path: "/tmp/font.eot" })).to.equal("Ready: /tmp/font.eot");
    });

    // This is what exactly one bundle is marked default for: otherwise it would be the last
    // one added, and the text on a missing key would depend on the directory walk order.
    it("falls back to the default locale on a key the locale is missing", async function () {
        await writeLocaleFile("ru", "greeting = Hi\nonly-in-default = Default bundle only");
        await writeLocaleFile("en", "greeting = Hello");

        const fluent = await createFluent(localeDir);

        expect(fluent.translate("en", "only-in-default")).to.equal("Default bundle only");
    });

    it("rejects a locale without a single file", async function () {
        await writeLocaleFile(DEFAULT_LOCALE, "greeting = Hi");
        const [missing] = LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);

        const error = await expectRejection(createFluent(localeDir), MissingLocaleBundle);

        expect(error.message).to.equal(`No translation files found for locale "${missing}".`);
        expect(error.payload).to.deep.equal({ path: localeDir, locale: missing });
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

    async function expectRejection<T extends Error>(promise: Promise<unknown>, expected: new (...params: never[]) => T): Promise<T> {
        try {
            await promise;
        } catch (error) {
            expect(error).to.be.instanceOf(expected);

            return error as T;
        }

        return expect.fail(`expected ${expected.name}`);
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

    // The shape of the properties is checked, not the values alone. The conversations plugin
    // writes into the op-log, and from there into the session, every own enumerable property
    // of the context except the intrinsic ones: the `fluent` field (with `useFluent()` a
    // `{ instance, useLocale, renegotiateLocale }` wrapper) must not be in the context, or
    // the parsed bundles will travel into `sessions` as an empty shell again. Functions the
    // plugin does not clone but restores bound to the live context, yet it remembers only
    // the keys of own enumerable properties — a `t` hidden behind a descriptor or carried
    // off onto the prototype would silently stop working inside a conversation.
    it("keeps Fluent in the context as own enumerable functions", async function () {
        const ctx = await runMiddleware("ru");

        expect(Object.keys(ctx)).to.include.members(["getFluent", "t"]);
        expect(Object.keys(ctx)).to.not.include("fluent");
        expect(ctx.getFluent()).to.equal(fluent);
    });

    async function runMiddleware(languageCode: string): Promise<Context> {
        const ctx = { from: { language_code: languageCode } } as unknown as Context;

        await createFluentMiddleware(fluent)(ctx, () => Promise.resolve());

        return ctx;
    }
});
