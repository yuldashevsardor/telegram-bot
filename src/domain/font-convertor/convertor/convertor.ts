import { InvalidFile, InvalidPath, PermissionDenied } from "app/helper/file-helper/file-helper.errors";
import path from "path";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { InvalidFontSignature } from "app/domain/font-convertor/font-convertor.errors";
import { FontSignature } from "app/domain/font-convertor/font-signature";
import { FileHelper } from "app/helper/file-helper/file-helper";

export abstract class Convertor {
    protected abstract fromExtension: Extension;
    protected abstract toExtension: Extension;

    protected constructor(private readonly fontSignature: FontSignature) {}

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
            throw InvalidFile.byPathAndExtension(fromPath, extension, this.fromExtension);
        }

        // Расширение задаёт тот, кто прислал файл, поэтому одного его мало: без этой
        // проверки произвольные байты под именем *.ttf ушли бы движку.
        const head = await FileHelper.readHead(fromPath, this.fontSignature.headLength);

        if (!this.fontSignature.matches(head, this.fromExtension)) {
            throw InvalidFontSignature.byPathAndExtension(fromPath, this.fromExtension);
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
            throw InvalidFile.byPathAndExtension(toPath, extension, this.toExtension);
        }
    }

    abstract convert(originPath: string, newPath: string): Promise<void>;
}
