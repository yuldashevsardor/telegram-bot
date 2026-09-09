import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import dayjs from "dayjs";
import {
    InvalidExtensions,
    InvalidPath,
    PermissionDenied,
    ReadFailed,
    RemoveFailed,
    WriteFailed,
} from "app/helper/file-helper/file-helper.errors";
import glob from "tiny-glob";

export class FileHelper {
    public static isExist(path: string): Promise<boolean> {
        return FileHelper.isReadable(path);
    }

    public static async isReadable(path: string): Promise<boolean> {
        try {
            await fs.access(path, fsSync.constants.R_OK);

            return true;
        } catch {
            return false;
        }
    }

    public static async isWritable(path: string): Promise<boolean> {
        try {
            await fs.access(path, fsSync.constants.W_OK);
            return true;
        } catch {
            return false;
        }
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
        //  Т.к. начинается с 0
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
     * Первые length байт файла. Файл короче — вернётся то, что есть.
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
     * Файл целиком.
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
     * Удаляет файл; отсутствие пути ошибкой не считается.
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

        const searchPattern = `**/*.{${filteredExtensions.join(",")}}`;

        return await glob(searchPattern, {
            cwd: basePath,
            filesOnly: true,
            dot: false,
            absolute: true,
        });
    }
}
