import { InvalidConfigError } from "app/shared/errors";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";

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

// Разбор строк источника в значения. Умолчание подставляется только вместо отсутствующей или
// пустой переменной; всё, что задано, но недопустимо, — InvalidConfigError с её именем на старте.
// Отдельный класс, а не приватные методы ConfigBuilder: у хелпера может ещё не быть вызова
// (getBoolean, getArray), а noUnusedLocals не пропускает приватный метод без вызовов.
export class ConfigReader {
    // Наибольшая задержка таймеров Node: знаковое 32-битное целое.
    public static readonly MAX_TIMER_DELAY = 2 ** 31 - 1;

    public constructor(private readonly storage: ConfigStorage) {}

    // Без умолчания переменная обязательна.
    public getString(name: string, defaultValue?: string): string {
        const value = this.storage.get(name)?.trim();

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
        const integer = value === "" ? defaultValue : ConfigReader.parseInteger(name, value);
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

    // Задержка setTimeout или setInterval, мс. Период меньше 1 мс или больше 2^31 - 1 мс Node
    // превращает в 1 мс (на переполнении — лишь с предупреждением): огромное значение, взятое, чтобы
    // «не срабатывать никогда», сработало бы сразу, а интервальный лог писался бы на каждом витке
    // событийного цикла. Ноль допускают только там, где он значит «не ждать».
    public getTimerDelay(name: string, defaultValue: number, { min = 1 }: { min?: number } = {}): number {
        return this.getInteger(name, defaultValue, { min: min, max: ConfigReader.MAX_TIMER_DELAY });
    }

    // Не через parseInt: "MAYBE" дал бы NaN, приведённый к false, и опечатку нельзя было бы
    // отличить от осознанного выключения.
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

    // ignoreCase отдаёт значение в написании из allowed, а не в том, в каком оно пришло.
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

    // Элементы разделяет запятая или точка с запятой, пробелы вокруг них отбрасываются. Каждый
    // элемент проверяет isElement: приведение результата к целевому типу у вызывающего пропустило
    // бы мусорный элемент. Пустой элемент ("a,,b", хвостовая запятая) тоже идёт на проверку.
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

        // Number, а не parseInt: тот молча съедает хвост ("10s" → 10) и на "abc" отдаёт NaN,
        // так что нечисловое значение уехало бы в конфиг незамеченным.
        if (!Number.isInteger(parsed)) {
            throw new InvalidConfigError(`Config value "${name}" must be an integer`, {
                got: value,
            });
        }

        return parsed;
    }
}
