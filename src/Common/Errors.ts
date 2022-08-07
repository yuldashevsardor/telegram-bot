import { AnyObject } from "App/Common/Types";

export class RuntimeError extends Error {
    public readonly message: string;
    public readonly code?: number;
    public readonly payload?: AnyObject;

    public constructor(params: { message: string; code?: number; payload?: AnyObject }) {
        super(params.message);

        this.message = params.message;
        this.code = params.code;
        this.payload = params.payload;
    }

    static byError(error: Error): RuntimeError {
        throw new RuntimeError({
            message: error.message,
            payload: error,
        });
    }
}

export class InvalidConfigError extends RuntimeError {}
