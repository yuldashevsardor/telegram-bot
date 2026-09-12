import path from "path";
import { InvalidPath, PermissionDenied } from "app/shared/fs/file-helper.errors";
import { inject, injectable } from "inversify";
import { FileHelper } from "app/shared/fs/file-helper";
import { ConvertParams, Extension } from "app/font-convertor/font-convertor.types";
import { FontConvertorError } from "app/font-convertor/font-convertor.errors";
import { StringHelper } from "app/shared/string-helper";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";

@injectable()
export class FontConvertor {
    private isPrepared = false;

    public constructor(
        @inject<ConvertorFactory>(Tokens.Font.Convertor.Factory) private readonly convertorFactory: ConvertorFactory,
        private readonly tempDir: string = configValue("tempDir"),
    ) {}

    private async prepare(): Promise<void> {
        if (this.isPrepared) {
            return;
        }

        if (!(await FileHelper.isExist(this.tempDir))) {
            throw InvalidPath.isNotExist(this.tempDir);
        }

        if (!(await FileHelper.isReadable(this.tempDir))) {
            throw PermissionDenied.read(this.tempDir);
        }

        if (!(await FileHelper.isWritable(this.tempDir))) {
            throw PermissionDenied.write(this.tempDir);
        }

        if (!(await FileHelper.isDirectory(this.tempDir))) {
            throw InvalidPath.isNotDirectory(this.tempDir);
        }

        this.isPrepared = true;
    }

    public async convert(params: ConvertParams): Promise<string> {
        await this.prepare();

        const originExtension = await FileHelper.getFileExtension(params.originPath);

        if (originExtension === params.extension) {
            throw new FontConvertorError("New and old font extension cannot be equal.");
        }

        const newFontFilename = StringHelper.generateRandomString(15) + "." + params.extension;
        const directory = await FileHelper.createDirectoriesByDate(this.tempDir);
        const newFontPath = path.join(directory, newFontFilename).toLowerCase();

        try {
            const convertor = this.convertorFactory.get(originExtension as Extension, params.extension);
            await convertor.convert(params.originPath, newFontPath);
        } catch (error) {
            throw FontConvertorError.byError(error);
        }

        return newFontPath;
    }
}
