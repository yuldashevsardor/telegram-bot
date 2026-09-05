import { UnknownObject } from "app/common/types";

type RuntimeErrorParams = { message: string; code?: number | undefined; payload?: UnknownObject | undefined };

export class RuntimeError extends Error {
    public override readonly message: string;
    public readonly code?: number | undefined;
    public readonly payload?: UnknownObject | undefined;

    public constructor(params: RuntimeErrorParams) {
        super(params.message);

        this.message = params.message;
        this.code = params.code;
        this.payload = params.payload;
    }

    static byError<T extends RuntimeError>(this: new (params: RuntimeErrorParams) => T, error: unknown): T {
        if (!(error instanceof Error)) {
            return new this({
                message: "byError got a value that is not an Error",
                payload: { error: error },
            });
        }

        return new this({
            message: error.message,
            payload: { error: error },
        });
    }
}

export class InvalidConfigError extends RuntimeError {}
