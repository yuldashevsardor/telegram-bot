import { AsyncLocalStorage } from "async_hooks";
import { AlsStore } from "app/infrastructure/async-local-storage.types";

// Переедет в ApplicationContext — issue #109.
export const asyncLocalStorage = new AsyncLocalStorage<AlsStore>();
