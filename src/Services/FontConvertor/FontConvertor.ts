import path from "path";
import { InvalidPath, PermissionDenied } from "App/Helpers/FileHelper/Errors";
import { inject, injectable } from "inversify";
import { Infrastructure } from "App/Config/Dependency/Symbols/Infrastructure";
import { Config } from "App/Config/Config";
import { FileHelper } from "App/Helpers/FileHelper/FileHelper";
import { ConvertParams, Extension } from "App/Services/FontConvertor/Types";
import { FontConvertorError } from "App/Services/FontConvertor/Errors";
import { StringHelper } from "App/Helpers/StringHelper";
import { ConvertorFactory } from "App/Services/FontConvertor/Convertor/ConvertorFactory";
import { Services } from "App/Config/Dependency/Symbols/Services";

@injectable()
export class FontConvertor {
    private readonly tempDir: string;
    private isPrepared = false;

    public constructor(
        @inject<Config>(Infrastructure.Config) private readonly config: Config,
        @inject<ConvertorFactory>(Services.FontConvertor.ConvertorFactory) private readonly convertorFactory: ConvertorFactory,
    ) {
        this.tempDir = this.config.tempDir;
    }

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
            throw new FontConvertorError(error.message);
        }

        return newFontPath;
    }
}
