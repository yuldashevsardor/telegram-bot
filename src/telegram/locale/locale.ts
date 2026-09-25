import path from "path";
import type { MiddlewareFn } from "grammy";
import { Fluent } from "@moebius/fluent";
import type { Context } from "app/telegram/bot/bot.types";
import { FileHelper } from "app/shared/fs/file-helper";
import type { Locale } from "app/telegram/locale/locale.types";
import { DEFAULT_LOCALE, LOCALES } from "app/telegram/locale/locale.types";
import { MissingLocaleBundle, UnknownLocale } from "app/telegram/locale/locale.errors";

export function isLocale(value: string): value is Locale {
    return (LOCALES as readonly string[]).includes(value);
}

// Telegram sends language_code as an IETF tag ("ru", "en-US", "pt-br"), while the bundles are
// keyed by language, so the region is dropped. An unknown language goes to the default locale:
// Fluent would find no bundle for it, and the user would get key names instead of text.
export function resolveLocale(languageCode: string | undefined): Locale {
    const language = languageCode?.split("-")[0]?.toLowerCase();

    return language !== undefined && isLocale(language) ? language : DEFAULT_LOCALE;
}

// The naming convention is `<something>.locale.<lang>.ftl`. This locale alone decides which
// bundle the file lands in.
export function localeFromFilePath(filePath: string): Locale {
    const nameParts = path.basename(filePath).split(".");
    const locale = nameParts.at(-2) ?? "";

    if (!isLocale(locale)) {
        throw UnknownLocale.byFilePath(filePath, locale);
    }

    return locale;
}

// Builds the bundles from every `.ftl` under localeDir. Kept apart from `Bot` because the
// order of addition and `isDefault` decide what the user sees on a missing key.
export async function createFluent(localeDir: string): Promise<Fluent> {
    const files = await FileHelper.findFilesByExtensions(localeDir, [".ftl"]);
    const filesByLocale = new Map<Locale, string[]>(LOCALES.map((locale) => [locale, []]));

    for (const filePath of files) {
        filesByLocale.get(localeFromFilePath(filePath))?.push(filePath);
    }

    const fluent = new Fluent();

    for (const [locale, localeFiles] of filesByLocale) {
        // Fluent would swallow a locale without files, and its users would silently end up
        // in the default one. In build/ this is how every `.ftl` goes missing at once.
        if (localeFiles.length === 0) {
            throw MissingLocaleBundle.byLocale(locale, localeDir);
        }

        await fluent.addTranslation({
            locales: locale,
            filePath: localeFiles,
            // No isolating: by default Fluent wraps every placeable in invisible
            // U+2068/U+2069, and they get into the message text. The placeables here carry
            // data the user copies (the path to the conversion result). There are no
            // right-to-left locales, and isolation exists for them.
            bundleOptions: { useIsolating: false },
            // Exactly one default bundle: Fluent appends it to the tail of the lookup chain,
            // and there a key missing from the user's locale returns text, not its own name.
            // With `isDefault` on every bundle the default was the last one added, so the
            // chain depended on the directory walk order.
            // Stryker disable next-line ConditionalExpression: `false` is equivalent while DEFAULT_LOCALE comes first in LOCALES: without a marked bundle Fluent makes the first added one the default (addTranslation in @moebius/fluent)
            isDefault: locale === DEFAULT_LOCALE,
        });
    }

    return fluent;
}

// Plugs Fluent into the pipeline instead of `useFluent()` from `@grammyjs/fluent`. Its
// enumerable `fluent` field the conversations plugin clones into the op-log and `sessions` on
// every `wait()`, and on replay returns it as an empty shell (docs/architecture/i18n.md).
// The plugin does not make the property name configurable, so it is replaced entirely.
// Parsing the `.ftl` and translating stay with `@moebius/fluent`; only the three lines of the
// plugin without `fluent` are repeated here.
// `getFluent()` and `ctx.t` are functions: those the conversations plugin does not clone but
// restores bound to the live context, so both work on replay, inside a conversation.
export function createFluentMiddleware(fluent: Fluent): MiddlewareFn<Context> {
    return (ctx, next) => {
        ctx.getFluent = (): Fluent => fluent;
        ctx.t = fluent.withLocale(resolveLocale(ctx.from?.language_code));

        return next();
    };
}
