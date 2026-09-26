import { AsyncLocalStorage } from "async_hooks";
import { v4 as uuid } from "uuid";
import type { RequestStore } from "app/platform/request-context/request-context.types";
import { REQUEST_KEYS } from "app/platform/request-context/request-context.types";

// The values of the current update and the scope they live in. AsyncLocalStorage is not handed
// out: callers get only operations on the scope, and only this class knows the shape of the store
// and its keys. Why — docs/architecture/logging.md, "RequestContext".
export class RequestContext {
    private readonly als = new AsyncLocalStorage<RequestStore>();

    // The id is born here, not at the caller. A caller opens a scope to connect the logs of an
    // update, not to choose the value of a key.
    public run<Result>(fn: () => Result): Result {
        return this.als.run({ [REQUEST_KEYS.REQUEST_ID]: uuid() }, fn);
    }

    // null rather than an error: no value is a normal case. A scope covers only what stands below
    // RequestContextMiddleware in the pipeline of an update. Everything else runs without one, the
    // steps above it included.
    public getRequestId(): string | null {
        const requestId = this.als.getStore()?.[REQUEST_KEYS.REQUEST_ID];

        return typeof requestId === "string" ? requestId : null;
    }

    // Only the known keys are returned. Nothing checks the keys of the store at runtime, and
    // without the filter the log format would depend on what was put into the store along the way.
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
