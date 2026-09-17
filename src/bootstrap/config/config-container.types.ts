import type { ConfigContainer } from "app/bootstrap/config/config-container";
import type { ConfigValues } from "app/bootstrap/config/config-values";

type Leaf = string | number | boolean | bigint | symbol | null | undefined;

// Снимок источника целиком: storage отдаёт переменные разом, а не по одной, поэтому builder видит
// их согласованными, даже если источник поменяется посреди сборки. Лежит здесь, а не у storage или
// builder: оба работают с ним и друг о друге не знают.
export type RawConfig = Readonly<Record<string, string | undefined>>;

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

// Снятие подписки: контейнер живёт всё время процесса, поэтому подписчик, который умирает
// раньше (спека, объект под замену), обязан уметь отцепиться.
export type Unsubscribe = () => void;

// Слушатель изменения в том виде, в каком его хранит контейнер: путь стёрт до строки, поэтому
// и значения стёрты до unknown. Типизированную пару значений собирает onChange() под свой путь.
export type ConfigChangeListener = (newValue: unknown, oldValue: unknown) => void;

// Отказ пересборки и всё, что бросили сами слушатели: наверху колбэк наблюдателя, бросать
// оттуда некуда, а логгера у конфигурации нет — она собирается раньше него.
export type ConfigErrorListener = (error: unknown) => void;

export type ConfigPath = Paths<ConfigValues>;

export type ConfigValue<Path extends ConfigPath> = ValueByPath<ConfigValues, Path>;

export type CC = ConfigContainer<ConfigValues>;
