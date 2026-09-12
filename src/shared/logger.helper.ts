import { Level, Levels } from "app/shared/logger.types";

export function isLevel(value: string): value is Level {
    return Levels.some((level) => level === value);
}
