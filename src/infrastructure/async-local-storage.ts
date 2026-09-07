import { AsyncLocalStorage } from "async_hooks";
import { AlsStore } from "app/infrastructure/async-local-storage.types";

// Ключи значений текущего апдейта. Логгер пишет в запись только их, поэтому значение под
// ключом мимо этого списка в лог не попадёт.
export const ALS_KEYS = {
    REQUEST_ID: "requestId",
};

// Переедет в ApplicationContext — issue #109.
export const asyncLocalStorage = new AsyncLocalStorage<AlsStore>();
