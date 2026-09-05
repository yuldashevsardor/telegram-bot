import { AsyncLocalStorage } from "async_hooks";

// Значения намеренно unknown: в хранилище запроса кладут не только логгер, а читающая
// сторона всё равно обязана сузить тип под то, что ей нужно.
export type RequestStore = Map<string, unknown>;

export const asyncLocalStorage = new AsyncLocalStorage<RequestStore>();
