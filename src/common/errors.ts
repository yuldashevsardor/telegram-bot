import { AnyObject } from "app/common/types";

export class RuntimeError extends Error {
    public override readonly message: string;
    public readonly code?: number | undefined;
    public readonly payload?: AnyObject | undefined;

    public constructor(params: { message: string; code?: number | undefined; payload?: AnyObject | undefined }) {
        super(params.message);

        this.message = params.message;
        this.code = params.code;
        this.payload = params.payload;
    }

    static byError(error: unknown): RuntimeError {
        const normalized = error instanceof Error ? error : new Error(String(error));

        throw new RuntimeError({
            message: normalized.message,
            payload: { error: normalized },
        });
    }
}

export class InvalidConfigError extends RuntimeError {}
