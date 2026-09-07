import { Level, Levels } from "app/domain/logger/logger.types";

export function isLevel(value: string): value is Level {
    return Levels.some((level) => level === value);
}
