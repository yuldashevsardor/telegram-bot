// Список локалей задан явно, а не выведен из найденных .ftl: локаль берётся из имени
// файла, и опечатка в нём иначе молча завела бы бандл несуществующего языка, в который
// никогда никто не попадёт.
export const LOCALES = ["ru", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "ru";
