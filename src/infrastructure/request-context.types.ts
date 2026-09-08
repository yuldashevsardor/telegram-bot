// Ключи значений текущего апдейта. Наружу их отдаёт только RequestContext.getValues(),
// поэтому значение под ключом мимо этого списка в лог не попадёт. as const обязателен: тип
// стора выведен отсюда, и без него опечатка в ключе компилировалась бы, а корреляция молча
// терялась.
export const REQUEST_KEYS = {
    REQUEST_ID: "requestId",
} as const;

export type RequestKey = (typeof REQUEST_KEYS)[keyof typeof REQUEST_KEYS];

// Значения остаются unknown: стор общий, и читающая сторона сужает тип под то, что ей нужно.
export type RequestStore = Partial<Record<RequestKey, unknown>>;
