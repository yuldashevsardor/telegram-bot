import type { UnknownObject } from "app/shared/types";

export class RuntimeError extends Error {
    public override readonly message: string;
    public readonly payload?: UnknownObject | undefined;

    public constructor(message: string, payloadOrCause?: UnknownObject | Error) {
        let payload: UnknownObject | undefined;

        if (payloadOrCause instanceof Error) {
            // The original error lives in the standard cause and not in payload: that way both the
            // log serializers and the ordinary output of Error see it.
            super(message, { cause: payloadOrCause });
        } else if (payloadOrCause?.["cause"] instanceof Error) {
            // The original error is taken out of payload: the log serializers guard only against
            // cycles (they look for a repeat along the current branch of the walk), so one and the
            // same error would be expanded into the record twice, by payload.cause and by cause.
            const { cause, ...rest } = payloadOrCause;

            super(message, { cause: cause });

            payload = Object.keys(rest).length > 0 ? rest : undefined;
        } else {
            super(message);

            payload = payloadOrCause;
        }

        this.message = message;
        this.payload = payload;
    }

    static byError<T extends RuntimeError>(this: new (...params: ConstructorParameters<typeof RuntimeError>) => T, error: unknown): T {
        if (!(error instanceof Error)) {
            return new this("byError got a value that is not an Error", { cause: error });
        }

        return new this(error.message, error);
    }
}

export class InvalidConfigError extends RuntimeError {}
