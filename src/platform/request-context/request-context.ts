import { AsyncLocalStorage } from "async_hooks";
import { v4 as uuid } from "uuid";
import type { RequestStore } from "app/platform/request-context/request-context.types";
import { REQUEST_KEYS } from "app/platform/request-context/request-context.types";

// The values of the current update and the scope they live in. AsyncLocalStorage is an
// implementation detail and is not handed out: callers need only operations on the scope, and
// only this class knows the shape of the store and its keys. Without the wrapper every side would
// build the store by hand, and correlation would depend on whether they do it the same way.
export class RequestContext {
    private readonly als = new AsyncLocalStorage<RequestStore>();

    // The id is born here, not at the caller: a scope is opened from outside to make the logs
    // of an update connected, not to choose the value of a key.
    public run<Result>(fn: () => Result): Result {
        return this.als.run({ [REQUEST_KEYS.REQUEST_ID]: uuid() }, fn);
    }

    // Outside a scope there is no value, and that is a normal case (background tasks, an error
    // after the scope is closed), hence null rather than an error.
    public getRequestId(): string | null {
        const requestId = this.als.getStore()?.[REQUEST_KEYS.REQUEST_ID];

        return typeof requestId === "string" ? requestId : null;
    }

    // Only the known keys are returned: the store is untyped, and without the filter the log
    // format would depend on what was put into the store along the way.
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
