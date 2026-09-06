export interface ConfigStorage {
    get(key: string): string | undefined;
}
