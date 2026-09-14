import path from "path";
import { inject, injectable } from "inversify";
import { FileHelper } from "app/shared/fs/file-helper";
import type { ConvertParams, Extension } from "app/font-convertor/font-convertor.types";
import { FontConvertorError } from "app/font-convertor/font-convertor.errors";
import { StringHelper } from "app/shared/string/string-helper";
import type { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";

@injectable()
export class FontConvertor {
    public constructor(
        @inject<ConvertorFactory>(Tokens.Font.Convertor.Factory) private readonly convertorFactory: ConvertorFactory,
        private readonly tempDir: string = configValue("tempDir"),
    ) {}

    public async convert(params: ConvertParams): Promise<string> {
        const originExtension = await FileHelper.getFileExtension(params.originPath);

        if (originExtension === params.extension) {
            throw new FontConvertorError("New and old font extension cannot be equal.");
        }

        const newFontFilename = StringHelper.generateRandomString(15).toLowerCase() + "." + params.extension;
        const directory = await FileHelper.createDirectoriesByDate(this.tempDir);
        const newFontPath = path.join(directory, newFontFilename);

        try {
            const convertor = this.convertorFactory.get(originExtension as Extension, params.extension);
            await convertor.convert(params.originPath, newFontPath);
        } catch (error) {
            throw FontConvertorError.byError(error);
        }

        return newFontPath;
    }
}
