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

// Plugs Fluent into the pipeline instead of `useFluent()` from `@grammyjs/fluent`, whose
// enumerable `fluent` field, under a name it does not let us change, would travel into the
// conversation op-log and `sessions` and come back an empty shell (docs/architecture/i18n.md).
// Parsing the `.ftl` and translating stay with `@moebius/fluent`; only the three lines of the
// plugin without `fluent` are repeated here.
export function createFluentMiddleware(fluent: Fluent): MiddlewareFn<Context> {
    return (ctx, next) => {
        ctx.getFluent = (): Fluent => fluent;
        // language_code is an IETF tag ("en-US", "pt-br") and goes to Fluent as is: its langneg
        // negotiates "en-US" to the "en" bundle, and an unknown language reaches the isDefault
        // bundle at the tail of every lookup chain (createFluent()).
        ctx.t = fluent.withLocale(ctx.from?.language_code ?? DEFAULT_LOCALE);

        return next();
    };
}
