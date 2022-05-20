import { FileHelper } from "../../../utils/file/FileHelper";
import { InvalidFile, InvalidPath, PermissionDenied } from "../../../utils/file/Errors";
import path from "path";
import { Extension } from "../Types";
import * as mime from "mime-types";

export abstract class Convertor {
    protected abstract fromExtension: Extension;
    protected abstract toExtension: Extension;
    protected abstract allowedMimeTypes: Array<string>;

    protected async validate(fromPath: string, toPath: string): Promise<void> {
        await this.validateFromPath(fromPath);
        await this.validateToPath(toPath);
    }

    private async validateFromPath(fromPath: string): Promise<void> {
        if (!(await FileHelper.isExist(fromPath))) {
            throw InvalidPath.isNotExist(fromPath);
        }

        if (!(await FileHelper.isReadable(fromPath))) {
            throw PermissionDenied.read(fromPath);
        }

        if (!(await FileHelper.isFile(fromPath))) {
            throw InvalidPath.isNotFile(fromPath);
        }

        const extension = (await FileHelper.getFileExtension(fromPath)).toLowerCase();

        if (extension !== this.fromExtension) {
            throw new InvalidFile(`File ${fromPath} extension is invalid. Got: ${extension}. Allowed: ${this.fromExtension}`);
        }

        const mimeTypeByExtension = mime.lookup(extension);

        if (!mimeTypeByExtension) {
            throw new InvalidFile(`Invalid file: ${fromPath}. Cannot get mime type`);
        }

        if (!this.allowedMimeTypes.includes(mimeTypeByExtension)) {
            throw InvalidFile.byPathAndMimeType(fromPath, mimeTypeByExtension);
        }
    }

    private async validateToPath(toPath: string): Promise<void> {
        if (await FileHelper.isExist(toPath)) {
            throw InvalidPath.isAlreadyExists(toPath);
        }

        const directoryPath = path.dirname(toPath);

        if (!(await FileHelper.isReadable(directoryPath))) {
            throw PermissionDenied.read(directoryPath);
        }

        if (!(await FileHelper.isWritable(directoryPath))) {
            throw PermissionDenied.write(directoryPath);
        }

        if (!(await FileHelper.isDirectory(directoryPath))) {
            throw InvalidPath.isNotDirectory(directoryPath);
        }

        const extension = (await FileHelper.getFileExtension(toPath)).toLowerCase();

        if (extension !== this.toExtension) {
            throw new InvalidPath(`New file path ${toPath} extension is invalid. Got: ${extension}. Allowed: ${this.toExtension}`);
        }
    }

    abstract convert(originPath: string, newPath: string): Promise<void>;
}
