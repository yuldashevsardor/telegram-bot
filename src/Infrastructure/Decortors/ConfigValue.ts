import { container } from "App/Infrastructure/Config/Dependency/Container";
import { Config } from "App/Infrastructure/Config/Config";
import { Infrastructure } from "App/Infrastructure/Config/Dependency/Symbols/Infrastructure";
import { RuntimeError } from "App/Common/Errors";

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
        let alreadyFoundValue: T;

        const getter = (): T => {
            if (alreadyFoundValue !== undefined) {
                return alreadyFoundValue;
            }

            const value = getConfigValue<T>(key, defaultValue);

            alreadyFoundValue = value;

            return value;
        };

        Object.defineProperty(target, propertyKey, {
            get: getter,
        });
    };
}
