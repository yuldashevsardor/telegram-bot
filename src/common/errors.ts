import { UnknownObject } from "app/common/types";

export class RuntimeError extends Error {
    public override readonly message: string;
    public readonly payload?: UnknownObject | undefined;

    public constructor(message: string, payloadOrCause?: UnknownObject | Error) {
        const isCause = payloadOrCause instanceof Error;
        // Исходная ошибка живёт в стандартном cause, а не в payload: так её видят
        // и сериализаторы логов, и обычный вывод Error.
        const cause = isCause ? payloadOrCause : payloadOrCause?.["cause"];

        super(message, cause instanceof Error ? { cause: cause } : undefined);

        this.message = message;
        this.payload = isCause ? undefined : payloadOrCause;
    }

    static byError<T extends RuntimeError>(this: new (...params: ConstructorParameters<typeof RuntimeError>) => T, error: unknown): T {
        if (!(error instanceof Error)) {
            return new this("byError got a value that is not an Error", { error: error });
        }

        return new this(error.message, error);
    }
}

export class InvalidConfigError extends RuntimeError {}
