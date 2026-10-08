import type { Fluent, TranslationContext } from "@moebius/fluent";

// Explicit, not derived from the .ftl on disk: a typo in a file name would otherwise silently
// create a bundle nobody is routed into (docs/architecture/i18n.md).
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
