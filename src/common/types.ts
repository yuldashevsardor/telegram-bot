export type AnyObject = {
    // Осознанный any: сюда кладут произвольные объекты сторонних библиотек (Error,
    // grammY Update). unknown в индексной сигнатуре ломает присваивание интерфейсов,
    // поэтому для чтения по вычисляемому ключу есть отдельный UnknownObject.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string | symbol]: any;
};

export type UnknownObject = {
    [key: string | symbol]: unknown;
};

export type IsOptional<T> = Extract<T, undefined> extends never ? false : true;

export type Func = (...args: never[]) => unknown;

export type IsFunction<T> = T extends Func ? true : false;

export type ExcludeFunctionsFromObject<T> = Pick<T, { [K in keyof T]: IsFunction<T[K]> extends true ? never : K }[keyof T]>;

export type Dto<T> = { [K in keyof ExcludeFunctionsFromObject<T>]: T[K] };

export type PartialDto<T> = Partial<Dto<T>>;
