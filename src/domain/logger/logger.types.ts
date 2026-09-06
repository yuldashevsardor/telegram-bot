export enum Level {
    CRITICAL = "CRITICAL",
    ERROR = "ERROR",
    WARNING = "WARNING",
    INFO = "INFO",
    DEBUG = "DEBUG",
}

// Вес уровня: чем больше, тем серьёзнее. Логируется всё, чей вес не меньше настроенного
// порога, поэтому порядок уровней задан явно, а не порядком объявления enum'а.
export const LevelSeverity: Record<Level, number> = {
    [Level.DEBUG]: 0,
    [Level.INFO]: 100,
    [Level.WARNING]: 200,
    [Level.ERROR]: 300,
    [Level.CRITICAL]: 400,
};

export const Levels = Object.keys(LevelSeverity) as Array<Level>;
