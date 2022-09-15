import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import dayjs from "dayjs";
import { InvalidPath, PermissionDenied } from "app/helper/file-helper/file-helper.errors";
import { promisify } from "util";
import { exec as execOrigin } from "child_process";
import { RuntimeError } from "app/common/errors";
import glob = require("tiny-glob");

export class FileHelper {
    public static isExist(path: string): Promise<boolean> {
        return FileHelper.isReadable(path);
    }

    public static async isReadable(path: string): Promise<boolean> {
        try {
            await fs.access(path, fsSync.constants.R_OK);

            return true;
        } catch (error) {
            return false;
        }
    }

    public static async isWritable(path: string): Promise<boolean> {
        try {
            await fs.access(path, fsSync.constants.W_OK);
            return true;
        } catch (error) {
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

        const pathWithDay = path.join(pathWithMonth, dateTime.day().toString());
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

        const exec = promisify(execOrigin);
        const command = `file --mime-type -b "${path}"`;
        const commandResult = await exec(command);

        return commandResult.stdout.trim();
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
            throw new RuntimeError({
                message: "Extensions cannot be empty.",
            });
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
