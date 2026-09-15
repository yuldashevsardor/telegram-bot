import type { ConfigContainer } from "app/bootstrap/config/config-container";
import type { ConfigValues } from "app/bootstrap/config/config-values";

type Leaf = string | number | boolean | bigint | symbol | null | undefined;

// Все «точечные» пути внутрь T: сам ключ, а для вложенного объекта — ещё и пути под ним.
// У листа набор путей пуст, и `${Key}.${never}` схлопывается в never, поэтому за примитив
// путь не продолжается.
export type Paths<T> = T extends Leaf
    ? never
    : {
          [Key in keyof T & string]: Key | `${Key}.${Paths<T[Key]>}`;
      }[keyof T & string];

export type ValueByPath<T, Path extends string> = Path extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
        ? ValueByPath<T[Key], Rest>
        : never
    : Path extends keyof T
    ? T[Path]
    : never;

export type ConfigPath = Paths<ConfigValues>;

export type ConfigValue<Path extends ConfigPath> = ValueByPath<ConfigValues, Path>;

export type CC = ConfigContainer<ConfigValues>;
