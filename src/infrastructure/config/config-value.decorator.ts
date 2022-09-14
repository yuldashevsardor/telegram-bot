import { container } from "app/infrastructure/container/container";
import { Config } from "app/infrastructure/config/config";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { RuntimeError } from "app/common/errors";

function getConfigValue<T>(key: string, defaultValue?: T): T {
    const config = container.get<Config>(Infrastructure.Config);
    const keys = key.split(".").filter((key) => key.trim() !== "");
    let value;

    if (keys.length < 1) {
        value = config[key];
    } else {
        value = keys.reduce((previousValue: any, key: string) => {
            if (previousValue === undefined) {
                return undefined;
            }

            return previousValue[key];
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

    return value;
}

export function ConfigValue<T>(key: string, defaultValue?: T): (target: any, propertyKey: string) => void {
    return (target: any, propertyKey: string) => {
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
