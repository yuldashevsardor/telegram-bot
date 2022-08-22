import path from "path";
import { InvalidPath, PermissionDenied } from "App/Infrastructure/Helpers/FileHelper/Errors";
import { inject, injectable } from "inversify";
import { FileHelper } from "App/Infrastructure/Helpers/FileHelper/FileHelper";
import { ConvertParams, Extension } from "App/Domain/FontConvertor/Types";
import { FontConvertorError } from "App/Domain/FontConvertor/Errors";
import { StringHelper } from "App/Infrastructure/Helpers/StringHelper";
import { ConvertorFactory } from "App/Domain/FontConvertor/Convertor/ConvertorFactory";
import { Services } from "App/Infrastructure/Config/Dependency/Symbols/Services";
import { ConfigValue } from "App/Infrastructure/Decortors/ConfigValue";

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
