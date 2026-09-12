import path from "path";
import { InvalidPath, PermissionDenied } from "app/helper/file-helper/file-helper.errors";
import { inject, injectable } from "inversify";
import { FileHelper } from "app/helper/file-helper/file-helper";
import { ConvertParams, Extension, FontConvertorSettings } from "app/domain/font-convertor/font-convertor.types";
import { FontConvertorError } from "app/domain/font-convertor/font-convertor.errors";
import { StringHelper } from "app/helper/string-helper";
import { ConvertorFactory } from "app/domain/font-convertor/convertor/convertor-factory";
import { Tokens } from "app/common/tokens";

@injectable()
export class FontConvertor {
    private isPrepared = false;

    public constructor(
        @inject<ConvertorFactory>(Tokens.Font.Convertor.Factory) private readonly convertorFactory: ConvertorFactory,
        @inject<FontConvertorSettings>(Tokens.Font.Convertor.Settings) private readonly settings: FontConvertorSettings,
    ) {}

    private async prepare(): Promise<void> {
        if (this.isPrepared) {
            return;
        }

        if (!(await FileHelper.isExist(this.settings.tempDir))) {
            throw InvalidPath.isNotExist(this.settings.tempDir);
        }

        if (!(await FileHelper.isReadable(this.settings.tempDir))) {
            throw PermissionDenied.read(this.settings.tempDir);
        }

        if (!(await FileHelper.isWritable(this.settings.tempDir))) {
            throw PermissionDenied.write(this.settings.tempDir);
        }

        if (!(await FileHelper.isDirectory(this.settings.tempDir))) {
            throw InvalidPath.isNotDirectory(this.settings.tempDir);
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
        const directory = await FileHelper.createDirectoriesByDate(this.settings.tempDir);
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
