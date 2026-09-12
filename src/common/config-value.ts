// Только тип: импорт стирается при сборке, поэтому рантайм-ребра из common в
// infrastructure нет — как нет и цикла, который держал прежний @ConfigValue, ходивший за
// конфигурацией в модульный синглтон container. Здесь её отдаёт ApplicationContext:
// конфигурация существует до контейнера, и спрашивать её у контейнера незачем.
import type { ConfigContainer } from "app/infrastructure/config/config-container";
import { ApplicationContext } from "app/infrastructure/application/application-context";
import { UnknownObject } from "app/common/types";
import { InvalidConfigError } from "app/common/errors";

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

// Значение конфигурации по «точечному» пути. Путь — строковый литерал, но не произвольный:
// его тип собран из формы ConfigContainer, поэтому несуществующий ключ, путь сквозь
// примитив и приватное поле конфига не компилируются, а редактор подсказывает доступные.
// Тип результата тоже берётся из конфигурации, а не объявляется на месте вызова.
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

    // Единственное приведение на весь модуль: обход по точкам компилятору не проследить,
    // но путь он уже сверил с ConfigContainer, и ValueByPath выводит тип из того же места,
    // откуда пришло значение.
    return value as ConfigValue<Path>;
}

export { configValue };
export type { ConfigPath, ConfigValue };
