import { AsyncLocalStorage } from "async_hooks";
import { UnknownObject } from "app/common/types";

// Реестр ключей хранилища запроса: сюда кладётся всё, что живёт в пределах одного апдейта
// и нужно коду, до которого не дотянуться параметром.
export enum AlsKey {
    RequestId = "requestId",
}

// Тип значения задаётся для каждого ключа отдельно, поэтому читающей стороне не приходится
// сужать unknown руками.
export type AlsValues = {
    [AlsKey.RequestId]: string;
};

export type AlsStore = Map<AlsKey, AlsValues[AlsKey]>;

// Ключи, которые логгеры подмешивают в каждую запись. Новый ключ попадает в логи только
// после добавления сюда: в хранилище лежит и то, чему в логе делать нечего.
export const LOGGABLE_ALS_KEYS: ReadonlyArray<AlsKey> = [AlsKey.RequestId];

export const asyncLocalStorage = new AsyncLocalStorage<AlsStore>();

export function runWithAlsStore<T>(values: Partial<AlsValues>, callback: () => T): T {
    const store: AlsStore = new Map(Object.entries(values) as Array<[AlsKey, AlsValues[AlsKey]]>);

    return asyncLocalStorage.run(store, callback);
}

// Логгер зовёт это в момент записи, а не хранит контекст у себя: поэтому один и тот же
// экземпляр логгера пишет с данными того запроса, внутри которого его вызвали.
export function getAlsLogContext(): UnknownObject | undefined {
    const store = asyncLocalStorage.getStore();

    if (!store) {
        return undefined;
    }

    const context: UnknownObject = {};

    for (const key of LOGGABLE_ALS_KEYS) {
        const value = store.get(key);

        if (value !== undefined) {
            context[key] = value;
        }
    }

    return Object.keys(context).length > 0 ? context : undefined;
}
