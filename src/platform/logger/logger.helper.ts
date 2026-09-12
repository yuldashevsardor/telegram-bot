import { Level, Levels } from "app/platform/logger/logger.types";

export function isLevel(value: string): value is Level {
    return Levels.some((level) => level === value);
}
