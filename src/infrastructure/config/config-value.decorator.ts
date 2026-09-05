import { container } from "app/infrastructure/container/container";
import { Config } from "app/infrastructure/config/config";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { RuntimeError } from "app/common/errors";
import { UnknownObject } from "app/common/types";

function getConfigValue<T>(key: string, defaultValue?: T): T {
    const config = container.get<Config>(Infrastructure.Config);
    const keys = key.split(".").filter((key) => key.trim() !== "");
    let value: unknown;

    if (keys.length < 1) {
        value = (config as unknown as UnknownObject)[key];
    } else {
        value = keys.reduce<unknown>((previousValue, key) => {
            if (previousValue === undefined) {
                return undefined;
            }

            return (previousValue as UnknownObject)[key];
        }, config);
    }

    if (value === undefined) {
        value = defaultValue;
    }

    if (value === undefined) {
        throw new RuntimeError({
            message: `Invalid config "${key}"`,
        });
    }

    return value as T;
}

export function ConfigValue<T>(key: string, defaultValue?: T): (target: object, propertyKey: string) => void {
    return (target: object, propertyKey: string) => {
        let value: T;

        const getter = (): T => {
            if (value === undefined) {
                value = getConfigValue<T>(key, defaultValue);
            }

            return value;
        };

        Object.defineProperty(target, propertyKey, {
            get: getter,
        });
    };
}
