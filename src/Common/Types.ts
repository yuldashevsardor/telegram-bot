export type AnyObject = {
    [key: string | symbol]: any;
};

export type IsOptional<T> = Extract<T, undefined> extends never ? false : true;

export type Func = (...args: any[]) => any;

export type IsFunction<T> = T extends Func ? true : false;

export type ExcludeFunctionsFromObject<T> = Pick<T, { [K in keyof T]: IsFunction<T[K]> extends true ? never : K }[keyof T]>;

export type Dto<T> = { [K in keyof ExcludeFunctionsFromObject<T>]: T[K] };

export type PartialDto<T> = Partial<Dto<T>>;
