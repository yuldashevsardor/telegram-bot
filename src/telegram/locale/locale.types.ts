import type { Fluent, TranslationContext } from "@moebius/fluent";

// Список локалей задан явно, а не выведен из найденных .ftl: локаль берётся из имени
// файла, и опечатка в нём иначе молча завела бы бандл несуществующего языка, в который
// никогда никто не попадёт.
export const LOCALES = ["ru", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "ru";

// Своё лицо контекста вместо `FluentContextFlavor` из `@grammyjs/fluent`: имя свойства
// плагина своим middleware не переопределить, а перечислимое поле с экземпляром Fluent
// уезжает в op-лог разговора и в `sessions` (см. `createFluentMiddleware`).
export type FluentFlavor = {
    getFluent: () => Fluent;
    t: (key: string, context?: TranslationContext) => string;
};
