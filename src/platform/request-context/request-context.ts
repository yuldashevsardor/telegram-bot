import { AsyncLocalStorage } from "async_hooks";
import { v4 as uuid } from "uuid";
import type { RequestStore } from "app/platform/request-context/request-context.types";
import { REQUEST_KEYS } from "app/platform/request-context/request-context.types";

// Значения текущего апдейта и область, в которой они живут. AsyncLocalStorage — деталь
// реализации и наружу не отдаётся: вызывающему хватает операций над областью, а форму
// стора и ключи знает только этот класс. Без обёртки каждая сторона собирала бы стор
// руками, и корреляция зависела бы от того, одинаково ли они это делают.
export class RequestContext {
    private readonly als = new AsyncLocalStorage<RequestStore>();

    // Идентификатор рождается здесь, а не у вызывающего: снаружи область открывают, чтобы
    // логи апдейта стали связными, а не чтобы выбрать значение ключа.
    public run<Result>(fn: () => Result): Result {
        return this.als.run({ [REQUEST_KEYS.REQUEST_ID]: uuid() }, fn);
    }

    // Вне области значения нет — это нормальный случай (фоновые задачи, ошибка после
    // свёрнутой области), поэтому null, а не ошибка.
    public getRequestId(): string | null {
        const requestId = this.als.getStore()?.[REQUEST_KEYS.REQUEST_ID];

        return typeof requestId === "string" ? requestId : null;
    }

    // Отдаются только известные ключи: стор нетипизирован, и без отбора формат лога
    // зависел бы от того, что в стор положили по дороге.
    public getValues(): RequestStore {
        const store = this.als.getStore();

        if (!store) {
            return {};
        }

        const values: RequestStore = {};

        for (const key of Object.values(REQUEST_KEYS)) {
            if (store[key] !== undefined) {
                values[key] = store[key];
            }
        }

        return values;
    }
}
