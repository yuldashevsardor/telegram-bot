import { inject, tagged } from "inversify";
import type { interfaces } from "inversify";
import { Tokens } from "app/common/tokens";
// Только тип: импорт стирается при сборке, поэтому рантайм-ребра из common в
// infrastructure нет — как нет и цикла, который держал прежний @ConfigValue, сам ходивший
// в модульный синглтон container.
import type { ConfigContainer } from "app/infrastructure/config/config-container";
import { UnknownObject } from "app/common/types";
import { InvalidConfigError, RuntimeError } from "app/common/errors";

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

// Ключ тега, под которым путь доезжает до биндинга Tokens.Infrastructure.ConfigValue:
// метаданные параметра — единственный канал между местом внедрения и резолвом. Оба конца
// тега держит этот модуль, наружу торчат только InjectConfig и getConfigPath.
const CONFIG_PATH_TAG = "configPath";

// Путь того параметра, ради которого сейчас резолвится Tokens.Infrastructure.ConfigValue.
function getConfigPath(context: interfaces.Context): string {
    const tag = context.currentRequest.target.getCustomTags()?.find((metadata) => metadata.key === CONFIG_PATH_TAG);

    // Сюда приводит только ручной @inject(Tokens.Infrastructure.ConfigValue) мимо
    // InjectConfig: тег вешает сам декоратор, и без него резолву нечего отдать.
    if (tag === undefined || typeof tag.value !== "string") {
        throw new RuntimeError("Config value is requested without a path, use @InjectConfig instead of @inject.", {
            target: context.currentRequest.target.name.value(),
        });
    }

    return tag.value;
}

function resolveConfigPath(config: ConfigContainer, path: string): unknown {
    const value = path.split(".").reduce<unknown>((current, key) => {
        if (current === null || typeof current !== "object") {
            return undefined;
        }

        return (current as UnknownObject)[key];
    }, config);

    // Путь проверен компилятором, поэтому сюда приводит не опечатка в нём, а расхождение
    // объявленной формы конфигурации с настоящей — необязательное поле, ставшее undefined.
    if (value === undefined) {
        throw new InvalidConfigError(`Invalid config "${path}"`, {
            path: path,
        });
    }

    return value;
}

// Путь — строковый литерал, но сверяется он с формой ConfigContainer: несуществующий
// ключ не компилируется, а редактор подсказывает доступные. Тип параметра компилятор при
// этом не сверяет: связи между декоратором и типом у параметра нет, поэтому объявленный
// тип остаётся на совести пишущего — расхождение поймает первый же резолв.
function InjectConfig<Path extends ConfigPath>(path: Path): ParameterDecorator {
    return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number): void => {
        inject(Tokens.Infrastructure.ConfigValue)(target, propertyKey, parameterIndex);
        tagged(CONFIG_PATH_TAG, path)(target, propertyKey, parameterIndex);
    };
}

export { getConfigPath, resolveConfigPath, InjectConfig };
export type { ConfigPath };
