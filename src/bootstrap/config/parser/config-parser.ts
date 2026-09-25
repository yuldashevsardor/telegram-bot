import { InvalidConfigError } from "app/shared/errors";
import type { RawConfig } from "app/bootstrap/config/container/config-container.types";

const Booleans = new Map([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
]);

export type IntegerRange = {
    min: number;
    max?: number;
};

// Parses the strings of a source snapshot strictly (docs/architecture/config.md). A separate class
// rather than private methods of the builder: noUnusedLocals rejects a private helper that has no
// call site yet (getBoolean, getArray).
export class ConfigParser {
    // The longest delay of a Node timer: a signed 32-bit integer.
    public static readonly MAX_TIMER_DELAY = 2 ** 31 - 1;

    public constructor(private readonly raw: RawConfig) {}

    // Without a default the variable is required.
    public getString(name: string, defaultValue?: string): string {
        const value = this.raw[name]?.trim();

        if (value !== undefined && value !== "") {
            return value;
        }

        if (defaultValue === undefined) {
            throw new InvalidConfigError(`Config value "${name}" is required`);
        }

        return defaultValue;
    }

    public getInteger(name: string, defaultValue: number, range: IntegerRange): number {
        const value = this.getString(name, "");
        const integer = value === "" ? defaultValue : ConfigParser.parseInteger(name, value);
        const { min, max = Infinity } = range;

        if (integer < min || integer > max) {
            const bounds = range.max === undefined ? `at least ${min}` : `between ${min} and ${max}`;

            throw new InvalidConfigError(`Config value "${name}" must be ${bounds}`, {
                got: integer,
                ...range,
            });
        }

        return integer;
    }

    public getPort(name: string, defaultValue: number): number {
        return this.getInteger(name, defaultValue, { min: 1, max: 65535 });
    }

    // The delay of a setTimeout or a setInterval, ms. Node turns a period below 1 ms or above
    // 2^31 - 1 ms into 1 ms, with nothing but a warning on an overflow. A "never fire" value would
    // fire at once, and an interval log would be written on every turn of the event loop. A zero is
    // allowed only where it means "do not wait".
    public getTimerDelay(name: string, defaultValue: number, { min = 1 }: { min?: number } = {}): number {
        return this.getInteger(name, defaultValue, { min: min, max: ConfigParser.MAX_TIMER_DELAY });
    }

    // Not through parseInt: "MAYBE" would give a NaN coerced to false, and a typo could not be told
    // apart from a deliberate switching off.
    public getBoolean(name: string, defaultValue: boolean): boolean {
        const value = this.getString(name, "");

        if (value === "") {
            return defaultValue;
        }

        const boolean = Booleans.get(value.toLowerCase());

        if (boolean === undefined) {
            throw new InvalidConfigError(`Config value "${name}" must be a boolean`, {
                got: value,
                allowed: [...Booleans.keys()],
            });
        }

        return boolean;
    }

    // ignoreCase returns the value in the spelling from allowed, not in the one it came in.
    public getEnum<T extends string>(name: string, allowed: readonly T[], defaultValue: T, { ignoreCase = false } = {}): T {
        const value = this.getString(name, "");

        if (value === "") {
            return defaultValue;
        }

        const found = allowed.find((option) => (ignoreCase ? option.toLowerCase() === value.toLowerCase() : option === value));

        if (found === undefined) {
            throw new InvalidConfigError(`Config value "${name}" must be one of the allowed values`, {
                got: value,
                allowed: allowed,
            });
        }

        return found;
    }

    // Elements are separated by a comma or a semicolon, with the spaces around them dropped. Every
    // element, a blank one ("a,,b", a trailing comma) included, goes through isElement: a cast at the
    // call site would let a junk element through.
    public getArray<T extends string>(name: string, isElement: (value: string) => value is T, defaultValue: T[]): T[] {
        const value = this.getString(name, "");

        if (value === "") {
            return defaultValue;
        }

        const elements: T[] = [];
        const invalid: string[] = [];

        for (const element of value.split(/[,;]/).map((part) => part.trim())) {
            if (isElement(element)) {
                elements.push(element);
            } else {
                invalid.push(element);
            }
        }

        if (invalid.length > 0) {
            throw new InvalidConfigError(`Config value "${name}" has invalid elements`, {
                got: value,
                invalid: invalid,
            });
        }

        return elements;
    }

    private static parseInteger(name: string, value: string): number {
        const parsed = Number(value);

        // Number and not parseInt: the latter silently eats the tail ("10s" → 10) and returns NaN
        // for "abc", so a non-numeric value would slip into the config unnoticed.
        if (!Number.isInteger(parsed)) {
            throw new InvalidConfigError(`Config value "${name}" must be an integer`, {
                got: value,
            });
        }

        return parsed;
    }
}
