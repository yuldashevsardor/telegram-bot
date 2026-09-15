// Снимок источника целиком: переменные отдаются разом, а не по одной, поэтому сборка конфига
// видит их согласованными, даже если источник поменяется посреди неё.
export type RawConfig = Readonly<Record<string, string | undefined>>;

// Промис — под источники, которые отдают значения по сети (vault), даже если env отдаёт их сразу.
export interface ConfigStorage {
    load(): Promise<RawConfig>;
}
