import type { UnknownObject } from "app/shared/types";

export class RuntimeError extends Error {
    public override readonly message: string;
    public readonly payload?: UnknownObject | undefined;

    public constructor(message: string, payloadOrCause?: UnknownObject | Error) {
        let payload: UnknownObject | undefined;

        if (payloadOrCause instanceof Error) {
            // Исходная ошибка живёт в стандартном cause, а не в payload: так её видят
            // и сериализаторы логов, и обычный вывод Error.
            super(message, { cause: payloadOrCause });
        } else if (payloadOrCause?.["cause"] instanceof Error) {
            // Исходную ошибку из payload убираем: сериализаторы логов защищаются только
            // от циклов (повтор ищут вдоль текущей ветки обхода), поэтому одну и ту же
            // ошибку по путям payload.cause и cause они развернули бы в запись дважды.
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
