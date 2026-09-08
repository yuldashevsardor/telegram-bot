import path from "path";
import { Composer, MiddlewareFn } from "grammy";
import { Fluent } from "@moebius/fluent";
import { useFluent } from "@grammyjs/fluent";
import { Context } from "app/infrastructure/bot/bot.types";
import { FileHelper } from "app/helper/file-helper/file-helper";
import { DEFAULT_LOCALE, Locale, LOCALES } from "app/infrastructure/bot/locale.types";
import { MissingLocaleBundle, UnknownLocale } from "app/infrastructure/bot/locale.errors";

export function isLocale(value: string): value is Locale {
    return (LOCALES as readonly string[]).includes(value);
}

// Telegram присылает language_code тегом IETF ("ru", "en-US", "pt-br"), а бандлы заведены
// по языку. Регион отбрасываем, незнакомый язык уводим в дефолтную локаль: иначе Fluent
// не нашёл бы бандл и пользователь получил бы имена ключей вместо текста.
export function resolveLocale(languageCode: string | undefined): Locale {
    const language = languageCode?.split("-")[0]?.toLowerCase();

    return language !== undefined && isLocale(language) ? language : DEFAULT_LOCALE;
}

// Соглашение об именах — `<что-то>.locale.<lang>.ftl`; локаль здесь единственный
// источник правды о том, в какой бандл попадёт файл.
export function localeFromFilePath(filePath: string): Locale {
    const nameParts = path.basename(filePath).split(".");
    const locale = nameParts.at(-2) ?? "";

    if (!isLocale(locale)) {
        throw UnknownLocale.byFilePath(filePath, locale);
    }

    return locale;
}

// Собирает бандлы из всех `.ftl` под localeDir. Отдельно от `Bot`, потому что порядок
// добавления и `isDefault` определяют, что увидит пользователь на нехватающем ключе.
export async function createFluent(localeDir: string): Promise<Fluent> {
    const files = await FileHelper.findFilesByExtensions(localeDir, [".ftl"]);
    const filesByLocale = new Map<Locale, string[]>(LOCALES.map((locale) => [locale, []]));

    for (const filePath of files) {
        filesByLocale.get(localeFromFilePath(filePath))?.push(filePath);
    }

    const fluent = new Fluent();

    for (const [locale, localeFiles] of filesByLocale) {
        // Локаль без файлов Fluent проглотил бы, и её пользователи молча уехали бы в
        // дефолтную; при сборке в build/ так теряются все `.ftl` разом.
        if (localeFiles.length === 0) {
            throw MissingLocaleBundle.byLocale(locale, localeDir);
        }

        await fluent.addTranslation({
            locales: locale,
            filePath: localeFiles,
            // Без isolating: Fluent по умолчанию оборачивает каждую подстановку в невидимые
            // U+2068/U+2069, и они уезжают в текст сообщения. Через подстановки здесь едут
            // данные, которые пользователь копирует (путь к результату конвертации), а
            // локалей с письмом справа налево, ради которых изоляция и нужна, нет.
            bundleOptions: { useIsolating: false },
            // Дефолтный бандл ровно один: Fluent дописывает его в хвост цепочки поиска, и
            // на нём ключ, которого нет в локали пользователя, отдаёт текст, а не своё имя.
            // С `isDefault` на каждом бандле дефолтным становился последний добавленный,
            // то есть цепочка зависела от порядка обхода каталогов.
            isDefault: locale === DEFAULT_LOCALE,
        });
    }

    return fluent;
}

// Подключает Fluent к пайплайну и прячет `ctx.fluent` от перечисления. Плагин разговоров
// на каждом `wait()` клонирует в op-лог все перечислимые свойства контекста, кроме четырёх
// интринсивных (`update`, `api`, `me`, `conversation`), а op-лог хранится в сессии. Из
// `useFluent()` туда уезжает `fluent` — целиком, вместе с разобранными бандлами: в
// `sessions` пишется бесполезный слепок (`Set`/`Map` схлопываются в `{}` уже при
// сериализации), а на реплее `ctx.fluent.instance` оказывается пустым. `t`/`translate`
// прятать не нужно: функции не клонируются, и плагин восстанавливает их биндом от живого
// контекста. После этого `ctx.fluent` внутри разговора нет вовсе — понадобится, его
// вернёт `conversation.run()`.
export function createFluentMiddleware(fluent: Fluent): MiddlewareFn<Context> {
    const composer = new Composer<Context>();

    composer.use(
        useFluent<Context>({
            fluent: fluent,
            defaultLocale: DEFAULT_LOCALE,
            localeNegotiator: (ctx) => resolveLocale(ctx.from?.language_code),
        }),
        (ctx, next) => {
            Object.defineProperty(ctx, "fluent", { enumerable: false });

            return next();
        },
    );

    return composer.middleware();
}
