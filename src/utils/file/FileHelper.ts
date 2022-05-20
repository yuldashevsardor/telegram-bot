import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { InvalidPath, PermissionDenied } from "./Errors";
import dayjs from "dayjs";

// import { Magic, MAGIC_MIME } from "mmmagic";

export class FileHelper {
    public static async isExist(path: string): Promise<boolean> {
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

    public static async createDirectoriesByData(basePath: string): Promise<string> {
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
        const year = dateTime.year();
        const month = dateTime.month();
        const day = dateTime.day();
        const hour = dateTime.hour();

        const pathWithYear = path.join(basePath, year.toString());
        if (!(await FileHelper.isExist(pathWithYear))) {
            await fs.mkdir(pathWithYear);
        }

        const pathWithMonth = path.join(pathWithYear, month.toString());
        if (!(await FileHelper.isExist(pathWithMonth))) {
            await fs.mkdir(pathWithMonth);
        }

        const pathWithDay = path.join(pathWithMonth, day.toString());
        if (!(await FileHelper.isExist(pathWithDay))) {
            await fs.mkdir(pathWithDay);
        }

        const pathWithHour = path.join(pathWithDay, hour.toString());
        if (!(await FileHelper.isExist(pathWithHour))) {
            await fs.mkdir(pathWithHour);
        }

        return pathWithHour;
    }

    // public static async getMimeType(path: string): Promise<string> {
    //     if (!(await FileHelper.isReadable(path))) {
    //         throw PermissionDenied.write(path);
    //     }
    //
    //     if (!(await FileHelper.isFile(path))) {
    //         throw InvalidPath.isNotFile(path);
    //     }
    //
    //     const magic = new Magic(MAGIC_MIME);
    //     const detectFile = promisify(magic.detectFile);
    //
    //     const mimeType = detectFile(path);
    //
    //     return Array.isArray(mimeType) && mimeType.length ? mimeType[0] : mimeType;
    // }
}
