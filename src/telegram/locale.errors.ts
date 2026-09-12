import { RuntimeError } from "app/common/errors";

export class UnknownLocale extends RuntimeError {
    public static byFilePath(filePath: string, locale: string): UnknownLocale {
        return new UnknownLocale(`Unknown locale "${locale}" in translation file name.`, {
            path: filePath,
            locale: locale,
        });
    }
}

export class MissingLocaleBundle extends RuntimeError {
    public static byLocale(locale: string, searchPath: string): MissingLocaleBundle {
        return new MissingLocaleBundle(`No translation files found for locale "${locale}".`, {
            path: searchPath,
            locale: locale,
        });
    }
}
