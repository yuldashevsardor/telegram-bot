import type { UnknownObject } from "app/shared/types";
import { InvalidConfigError } from "app/shared/errors";
import type { Paths, ValueByPath } from "app/bootstrap/config/config-container.types";
import type { ConfigBuilder } from "app/bootstrap/config/builder/config-builder";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import { ConfigContainerIsNotInitialized } from "app/bootstrap/config/config-container.errors";

// Хранит значения и отдаёт их по пути; откуда они берутся и как проверяются, решают storage и
// builder. Сборка вынесена из конструктора в init(): источник может отдавать значения только
// асинхронно (vault), а конструктор ждать не умеет.
export class ConfigContainer<Values> {
    private values: Values | null = null;

    public constructor(private readonly storage: ConfigStorage, private readonly builder: ConfigBuilder<Values>) {}

    public async init(): Promise<void> {
        this.values = this.builder.build(await this.storage.load());
    }

    public get<Path extends Paths<Values> & string>(dottedPath: Path): ValueByPath<Values, Path> {
        if (this.values === null) {
            throw new ConfigContainerIsNotInitialized("ConfigContainer is not initialized, call init() first.");
        }

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
