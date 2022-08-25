import { InvalidFile, InvalidPath, PermissionDenied } from "App/Helper/FileHelper/Errors";
import path from "path";
import * as mime from "mime-types";
import { Extension } from "App/Domain/FontConvertor/Types";
import { FileHelper } from "App/Helper/FileHelper/FileHelper";

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
            throw new InvalidFile({
                message: "Invalid file extension",
                payload: {
                    filePath: fromPath,
                    extension: extension,
                    allowed: this.fromExtension,
                },
            });
        }

        const mimeTypeByExtension = mime.lookup(extension);

        if (!mimeTypeByExtension) {
            throw new InvalidFile({
                message: "Invalid file. Cannot get mime type",
                payload: {
                    path: fromPath,
                },
            });
        }

        if (!this.allowedMimeTypes.includes(mimeTypeByExtension)) {
            throw InvalidFile.byPathAndMimeType(fromPath, mimeTypeByExtension);
        }

        // const mimeTypeByFile = await FileHelper.getMimeType(fromPath);
        // if (!mimeTypeByFile || !this.allowedMimeTypes.includes(mimeTypeByFile)) {
        //     throw InvalidFile.byPathAndMimeType(fromPath, mimeTypeByFile);
        // }
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
            throw new InvalidFile({
                message: "New file extension is invalid",
                payload: {
                    filePath: toPath,
                    extension: extension,
                    allowed: this.toExtension,
                },
            });
        }
    }

    abstract convert(originPath: string, newPath: string): Promise<void>;
}
