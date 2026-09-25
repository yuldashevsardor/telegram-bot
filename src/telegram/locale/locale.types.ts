import type { Fluent, TranslationContext } from "@moebius/fluent";

// Explicit, not derived from the .ftl found on disk: the locale is taken from the file name,
// and a typo in it would silently create a bundle for a language that does not exist and that
// nobody is ever routed into.
export const LOCALES = ["ru", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "ru";

// Our own flavor instead of `FluentContextFlavor` from `@grammyjs/fluent`: its property name is
// fixed, and an enumerable field with the Fluent instance travels into the conversation op-log
// and `sessions` (see `createFluentMiddleware`).
export type FluentFlavor = {
    getFluent: () => Fluent;
    t: (key: string, context?: TranslationContext) => string;
};
