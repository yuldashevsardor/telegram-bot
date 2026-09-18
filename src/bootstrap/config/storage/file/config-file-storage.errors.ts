import { RuntimeError } from "app/shared/errors";

export class ConfigFileUnreadable extends RuntimeError {
    public static byPath(filePath: string, error: unknown): ConfigFileUnreadable {
        return new ConfigFileUnreadable(`Config file "${filePath}" is unreadable`, { path: filePath, cause: error });
    }
}
