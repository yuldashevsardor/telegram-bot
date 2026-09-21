import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import dayjs from "dayjs";
import { InvalidExtensions, InvalidPath, PermissionDenied, ReadFailed, RemoveFailed, WriteFailed } from "app/shared/fs/file-helper.errors";

export class FileHelper {
    // F_OK and not R_OK: with R_OK an existing unreadable path would pass for a missing one. A check
    // of "the path is free" would then let a write over such a file through, and a check of
    // readability that follows a check of existence would never fire.
    public static isExist(path: string): Promise<boolean> {
        return FileHelper.hasAccess(path, fsSync.constants.F_OK);
    }

    public static isReadable(path: string): Promise<boolean> {
        return FileHelper.hasAccess(path, fsSync.constants.R_OK);
    }

    public static isWritable(path: string): Promise<boolean> {
        return FileHelper.hasAccess(path, fsSync.constants.W_OK);
    }

    public static async isFile(path: string): Promise<boolean> {
        const fileStat = await fs.stat(path);

        return fileStat.isFile();
    }

    public static async isDirectory(path: string): Promise<boolean> {
        const fileStat = await fs.stat(path);

        return fileStat.isDirectory();
    }

    public static async getFileExtension(filePath: string): Promise<string> {
        let extension = path.extname(filePath);
        // Stryker disable next-line ConditionalExpression: `true` is equivalent: extname hands back either an empty string or an extension with a dot, and substring(1) of an empty string is an empty string
        if (extension.charAt(0) === ".") {
            extension = extension.substring(1);
        }
        return extension;
    }

    public static async createDirectoriesByDate(basePath: string): Promise<string> {
        if (!(await FileHelper.isExist(basePath))) {
            throw InvalidPath.isNotExist(basePath);
        }

        if (!(await FileHelper.isReadable(basePath))) {
            throw PermissionDenied.read(basePath);
        }

        if (!(await FileHelper.isWritable(basePath))) {
            throw PermissionDenied.write(basePath);
        }

        if (!(await FileHelper.isDirectory(basePath))) {
            throw InvalidPath.isNotDirectory(basePath);
        }

        const dateTime = dayjs();
        // Months are counted from 0
        const month = dateTime.month() + 1;

        const pathWithYear = path.join(basePath, dateTime.year().toString());
        if (!(await FileHelper.isExist(pathWithYear))) {
            fsSync.mkdirSync(pathWithYear);
        }

        const pathWithMonth = path.join(pathWithYear, month.toString());
        if (!fsSync.existsSync(pathWithMonth)) {
            fsSync.mkdirSync(pathWithMonth);
        }

        const pathWithDay = path.join(pathWithMonth, dateTime.date().toString());
        if (!fsSync.existsSync(pathWithDay)) {
            fsSync.mkdirSync(pathWithDay);
        }

        return pathWithDay;
    }

    /**
     * The first length bytes of the file. If the file is shorter, what there is comes back.
     */
    public static async readHead(path: string, length: number): Promise<Uint8Array> {
        const buffer = new Uint8Array(length);
        let file;

        try {
            file = await fs.open(path, "r");
        } catch (error) {
            throw ReadFailed.byPath(path, error);
        }

        try {
            const { bytesRead } = await file.read(buffer, 0, length, 0);

            return buffer.subarray(0, bytesRead);
        } catch (error) {
            throw ReadFailed.byPath(path, error);
        } finally {
            await file.close();
        }
    }

    /**
     * The whole file.
     */
    public static async read(path: string): Promise<Uint8Array> {
        try {
            const content = await fs.readFile(path);

            return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
        } catch (error) {
            throw ReadFailed.byPath(path, error);
        }
    }

    public static async write(path: string, data: Uint8Array): Promise<void> {
        try {
            await fs.writeFile(path, data);
        } catch (error) {
            throw WriteFailed.byPath(path, error);
        }
    }

    /**
     * Removes the file; a missing path does not count as an error.
     */
    public static async remove(path: string): Promise<void> {
        try {
            await fs.rm(path, { force: true });
        } catch (error) {
            throw RemoveFailed.byPath(path, error);
        }
    }

    public static async findFilesByExtensions(basePath: string, extensions: string[]): Promise<Array<string>> {
        const filteredExtensions = extensions
            .map((extension) => {
                extension = extension.trim();

                if (extension.startsWith(".")) {
                    extension = extension.substring(1);
                }

                return extension;
            })
            .filter((extension) => extension !== "");

        if (!filteredExtensions.length) {
            throw InvalidExtensions.empty(extensions);
        }

        // A pattern per extension rather than one `**/*.{ttf,otf}`: braces around a single element
        // are left by glob literally, and `**/*.{ftl}` would find nothing. Hidden files and
        // directories are skipped by glob itself, and it has no option for that. Just as silently,
        // with no error, it skips a directory that cannot be read or does not exist, including
        // basePath itself: the caller notices the files that fell out only by checking the result.
        const searchPatterns = filteredExtensions.map((extension) => `**/*.${extension}`);
        const files: string[] = [];

        for await (const entry of fs.glob(searchPatterns, { cwd: basePath, withFileTypes: true })) {
            // A directory whose name matches is handed back by glob as well.
            if (entry.isFile()) {
                files.push(path.resolve(entry.parentPath, entry.name));
            }
        }

        return files;
    }

    private static async hasAccess(path: string, mode: number): Promise<boolean> {
        try {
            await fs.access(path, mode);

            return true;
        } catch {
            return false;
        }
    }
}
