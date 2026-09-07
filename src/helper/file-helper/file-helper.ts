import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import dayjs from "dayjs";
import { InvalidExtensions, InvalidPath, PermissionDenied } from "app/helper/file-helper/file-helper.errors";
import { ProcessHelper } from "app/helper/process-helper/process-helper";
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

    public static async getMimeType(path: string): Promise<string> {
        if (!(await FileHelper.isReadable(path))) {
            throw PermissionDenied.write(path);
        }

        if (!(await FileHelper.isFile(path))) {
            throw InvalidPath.isNotFile(path);
        }

        const result = await ProcessHelper.run("file", ["--mime-type", "-b", path]);

        return result.stdout.trim();
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
