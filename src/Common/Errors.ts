import { AnyObject } from "App/Common/Types";

export class RuntimeError extends Error {
    public constructor(public readonly message: string, public readonly code?: number, public readonly payload?: AnyObject) {
        super(message);
    }
}
