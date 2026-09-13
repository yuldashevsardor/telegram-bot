// Конфигурация берётся у ApplicationContext, а не из DI-контейнера: она существует до
// контейнера, поэтому спрашивать её у контейнера незачем. Так же снимается цикл импорта,
// который держал прежний @ConfigValue, ходивший за ней в модульный синглтон container.
import { ApplicationContext } from "app/bootstrap/application/application-context";
// Только тип: импорт стирается при сборке.
import type { ConfigContainer } from "app/bootstrap/config-container";
import type { UnknownObject } from "app/shared/types";
import { InvalidConfigError } from "app/shared/errors";

type Leaf = string | number | boolean | bigint | symbol | null | undefined;

// Все «точечные» пути внутрь T: сам ключ, а для вложенного объекта — ещё и пути под ним.
// У листа набор путей пуст, и `${Key}.${never}` схлопывается в never, поэтому за примитив
// путь не продолжается. Приватные поля и методы ConfigContainer сюда не попадают: keyof
// класса перечисляет только публичное.
type ConfigPaths<T> = T extends Leaf
    ? never
    : {
          [Key in keyof T & string]: Key | `${Key}.${ConfigPaths<T[Key]>}`;
      }[keyof T & string];

type ConfigPath = ConfigPaths<ConfigContainer>;

type ValueByPath<T, Path extends string> = Path extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
        ? ValueByPath<T[Key], Rest>
        : never
    : Path extends keyof T
    ? T[Path]
    : never;

type ConfigValue<Path extends ConfigPath> = ValueByPath<ConfigContainer, Path>;

// Значение конфигурации по «точечному» пути; ставится умолчанием параметра конструктора.
// Почему функция, а не декоратор, и на чём это держится — docs/architecture/application.md,
// раздел «DI».
function configValue<Path extends ConfigPath>(path: Path): ConfigValue<Path> {
    const value = path.split(".").reduce<unknown>((current, key) => {
        if (current === null || typeof current !== "object") {
            return undefined;
        }

        return (current as UnknownObject)[key];
    }, ApplicationContext.getConfigContainer());

    // Путь проверен компилятором, поэтому сюда приводит не опечатка в нём, а расхождение
    // объявленной формы конфигурации с настоящей — необязательное поле, ставшее undefined.
    if (value === undefined) {
        throw new InvalidConfigError(`Invalid config "${path}"`, {
            path: path,
        });
    }

    // Единственное приведение на весь модуль: обход по точкам компилятору не проследить, но
    // путь он уже сверил с ConfigContainer, и ValueByPath выводит тип из того же места,
    // откуда пришло значение.
    return value as ConfigValue<Path>;
}

export { configValue };
