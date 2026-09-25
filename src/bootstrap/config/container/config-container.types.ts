import type { ConfigContainer } from "app/bootstrap/config/container/config-container";
import type { ConfigValues } from "app/bootstrap/config/config-values";

type Leaf = string | number | boolean | bigint | symbol | null | undefined;

// The whole snapshot at once, not variable by variable: the builder sees consistent values even
// if the source changes during an assembly. It lives here because the storage and the builder both
// work with it and neither knows about the other.
export type RawConfig = Readonly<Record<string, string | undefined>>;

// Every dotted path into T: the key itself, and for a nested object the paths under it as well.
// A leaf has an empty set of paths, and `${Key}.${never}` collapses into never, so a path is not
// continued past a primitive.
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

// The container lives as long as the process, so a subscriber that dies earlier (a spec, an object
// about to be replaced) has to be able to detach.
export type Unsubscribe = () => void;

// A change listener as the container keeps it: the path is erased to a string, so the values are
// erased to unknown. onChange() restores the typed pair for its own path.
export type ConfigChangeListener = (newValue: unknown, oldValue: unknown) => void;

// A failure of a rebuild and anything the listeners threw. There is nowhere to throw from the
// watcher callback, and the configuration has no logger: it is assembled before one.
export type ConfigErrorListener = (error: unknown) => void;

export type ConfigPath = Paths<ConfigValues>;

export type ConfigValue<Path extends ConfigPath> = ValueByPath<ConfigValues, Path>;

export type CC = ConfigContainer<ConfigValues>;
