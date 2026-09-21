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

// Telegram sends language_code as an IETF tag ("ru", "en-US", "pt-br"), while the bundles
// are keyed by language. The region is dropped and an unknown language goes to the default
// locale: otherwise Fluent would find no bundle and the user would get key names instead of
// text.
export function resolveLocale(languageCode: string | undefined): Locale {
    const language = languageCode?.split("-")[0]?.toLowerCase();

    return language !== undefined && isLocale(language) ? language : DEFAULT_LOCALE;
}

// The naming convention is `<something>.locale.<lang>.ftl`; the locale here is the single
// source of truth about which bundle the file lands in.
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
        // in the default one; in build/ that is how every `.ftl` goes missing at once.
        if (localeFiles.length === 0) {
            throw MissingLocaleBundle.byLocale(locale, localeDir);
        }

        await fluent.addTranslation({
            locales: locale,
            filePath: localeFiles,
            // No isolating: by default Fluent wraps every placeable in invisible
            // U+2068/U+2069, and they travel into the text of the message. What travels
            // through the placeables here is data the user copies (the path to the
            // conversion result), and there are no right-to-left locales, which is what the
            // isolation is there for.
            bundleOptions: { useIsolating: false },
            // There is exactly one default bundle: Fluent appends it to the tail of the
            // lookup chain, and on it a key missing from the user's locale returns text and
            // not its own name. With `isDefault` on every bundle the default became the last
            // one added, that is, the chain depended on the directory walk order.
            // Stryker disable next-line ConditionalExpression: `false` is equivalent while DEFAULT_LOCALE comes first in LOCALES: without a marked bundle Fluent makes the first added one the default (addTranslation in @moebius/fluent)
            isDefault: locale === DEFAULT_LOCALE,
        });
    }

    return fluent;
}

// Plugs Fluent into the pipeline instead of `useFluent()` from `@grammyjs/fluent`: that one
// puts `fluent`, `translate` and `t` into the context with a single `Object.assign`, and the
// enumerable `fluent` field the conversations plugin clones on every `wait()` into the
// op-log and into `sessions` (docs/architecture/invariants.md) — whole, together with the
// parsed bundles, and on replay returns it as an empty shell (the `Set` of bundles and the
// `Map` of messages collapse into `{}` on serialization).
// The plugin does not make the property name configurable, so it is replaced entirely:
// parsing the `.ftl` and translating stay with `@moebius/fluent`, and only three lines of
// the plugin, the ones without `fluent`, are repeated here.
// The instance lies in the context as a function: functions the conversations plugin does
// not clone but restores bound to the live context, so `getFluent()` works on replay too,
// inside a conversation. `ctx.t` lives there by the same mechanism.
export function createFluentMiddleware(fluent: Fluent): MiddlewareFn<Context> {
    return (ctx, next) => {
        ctx.getFluent = (): Fluent => fluent;
        ctx.t = fluent.withLocale(resolveLocale(ctx.from?.language_code));

        return next();
    };
}
