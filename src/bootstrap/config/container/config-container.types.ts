import type { ConfigContainer } from "app/bootstrap/config/container/config-container";
import type { ConfigValues } from "app/bootstrap/config/config-values";

type Leaf = string | number | boolean | bigint | symbol | null | undefined;

// The snapshot of the source as a whole: the storage hands the variables over at once rather than
// one by one, so the builder sees them consistent even if the source changes in the middle of an
// assembly. It lives here rather than with the storage or the builder: both work with it and neither
// knows about the other.
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

// Unsubscribing: the container lives for the whole life of the process, so a subscriber that dies
// earlier (a spec, an object that is about to be replaced) has to be able to detach.
export type Unsubscribe = () => void;

// A change listener in the form the container keeps it in: the path is erased to a string, so the
// values are erased to unknown as well. The typed pair of values is assembled by onChange() for its
// own path.
export type ConfigChangeListener = (newValue: unknown, oldValue: unknown) => void;

// A failure of a rebuild and anything the listeners themselves threw: above lies the callback of
// the watcher, there is nowhere to throw from there, and the configuration has no logger — it is
// assembled before one.
export type ConfigErrorListener = (error: unknown) => void;

export type ConfigPath = Paths<ConfigValues>;

export type ConfigValue<Path extends ConfigPath> = ValueByPath<ConfigValues, Path>;

export type CC = ConfigContainer<ConfigValues>;
