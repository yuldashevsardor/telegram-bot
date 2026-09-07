import { AsyncLocalStorage } from "async_hooks";
import { AlsStore } from "app/infrastructure/async-local-storage.types";

// Ключи значений текущего апдейта. Логгер читает хранилище целиком и пишет всё, что там
// лежит, поэтому сюда кладётся только то, чему место в каждой записи запроса.
export const ALS_KEYS = {
    REQUEST_ID: "requestId",
};

// Переедет в ApplicationContext — issue #109.
export const asyncLocalStorage = new AsyncLocalStorage<AlsStore>();
