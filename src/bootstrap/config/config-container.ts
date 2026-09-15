import type { UnknownObject } from "app/shared/types";
import { InvalidConfigError } from "app/shared/errors";
import type { Paths, ValueByPath } from "app/bootstrap/config/config-container.types";

// Только хранит готовые значения и отдаёт их по пути: разбор и проверки — у ConfigBuilder, поэтому
// к моменту создания контейнера конфигурация уже провалидирована.
export class ConfigContainer<Values extends object> {
    public constructor(private readonly values: Values) {}

    public get<Path extends Paths<Values> & string>(dottedPath: Path): ValueByPath<Values, Path> {
        const value = dottedPath.split(".").reduce<unknown>((current, key) => {
            if (current === null || typeof current !== "object") {
                return undefined;
            }

            return (current as UnknownObject)[key];
        }, this.values);

        // Путь проверен компилятором, поэтому сюда приводит не опечатка в нём, а расхождение
        // объявленной формы конфигурации с настоящей — необязательное поле, ставшее undefined.
        if (value === undefined) {
            throw new InvalidConfigError(`Invalid config "${dottedPath}"`, {
                path: dottedPath,
            });
        }

        // Приведение результата: обход по точкам компилятору не проследить, но путь он уже сверил
        // с Values, и ValueByPath выводит тип из того же места, откуда пришло значение.
        return value as ValueByPath<Values, Path>;
    }
}
