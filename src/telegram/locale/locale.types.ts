import type { Fluent, TranslationContext } from "@moebius/fluent";

// The locale list is explicit instead of derived from the .ftl found on disk: the locale is
// taken from the file name, and a typo in it would otherwise silently create a bundle for a
// language that does not exist and that nobody is ever routed into.
export const LOCALES = ["ru", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "ru";

// Our own context flavor instead of `FluentContextFlavor` from `@grammyjs/fluent`: the
// plugin's property name cannot be overridden by our own middleware, and an enumerable field
// holding the Fluent instance travels into the conversation op-log and into `sessions`
// (see `createFluentMiddleware`).
export type FluentFlavor = {
    getFluent: () => Fluent;
    t: (key: string, context?: TranslationContext) => string;
};
