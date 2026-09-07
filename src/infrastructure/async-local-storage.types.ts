// Ключи значений текущего апдейта. Логгер пишет в запись только их, поэтому значение под
// ключом мимо этого списка в лог не попадёт. as const обязателен: тип стора выведен
// отсюда, и без него опечатка в ключе компилировалась бы, а корреляция молча терялась.
export const ALS_KEYS = {
    REQUEST_ID: "requestId",
} as const;

export type AlsKey = (typeof ALS_KEYS)[keyof typeof ALS_KEYS];

// Значения остаются unknown: стор общий, и читающая сторона сужает тип под то, что ей нужно.
export type AlsStore = Partial<Record<AlsKey, unknown>>;
