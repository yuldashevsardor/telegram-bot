import path from "path";
import { InvalidPath, PermissionDenied } from "app/helper/file-helper/file-helper.errors";
import { inject, injectable } from "inversify";
import { FileHelper } from "app/helper/file-helper/file-helper";
import { ConvertParams, Extension } from "app/domain/font-convertor/font-convertor.types";
import { FontConvertorError } from "app/domain/font-convertor/font-convertor.errors";
import { StringHelper } from "app/helper/string-helper";
import { ConvertorFactory } from "app/domain/font-convertor/convertor/convertor-factory";
import { Services } from "app/infrastructure/container/symbols/services";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";

@injectable()
export class FontConvertor {
    @ConfigValue<string>("tempDir")
    private readonly tempDir!: string;
    private isPrepared = false;

    public constructor(
        @inject<ConvertorFactory>(Services.FontConvertor.ConvertorFactory) private readonly convertorFactory: ConvertorFactory,
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
            throw new FontConvertorError({
                message: "New and old font extension cannot be equal.",
            });
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
