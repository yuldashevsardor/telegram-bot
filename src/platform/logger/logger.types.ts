export enum Level {
    CRITICAL = "CRITICAL",
    ERROR = "ERROR",
    WARNING = "WARNING",
    INFO = "INFO",
    DEBUG = "DEBUG",
}

// The weight of a level: the higher, the more severe. A record is logged when its weight is not
// below the threshold's, so the order is set here explicitly, not by the enum declaration order.
export const LevelSeverity: Record<Level, number> = {
    [Level.DEBUG]: 0,
    [Level.INFO]: 100,
    [Level.WARNING]: 200,
    [Level.ERROR]: 300,
    [Level.CRITICAL]: 400,
};

export const Levels = Object.keys(LevelSeverity) as Array<Level>;
