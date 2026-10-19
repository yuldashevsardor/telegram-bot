import { inject, injectable } from "inversify";
import { FileHelper } from "app/shared/fs/file-helper";
import type { ConvertParams, Extension } from "app/font-convertor/font-convertor.types";
import { FontConvertorError } from "app/font-convertor/font-convertor.errors";
import type { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import type { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";

@injectable()
export class FontConvertor {
    public constructor(
        @inject<ConvertorFactory>(Tokens.Font.Convertor.Factory) private readonly convertorFactory: ConvertorFactory,
        @inject<FontValidatorResolver>(Tokens.Font.Validator.Resolver) private readonly fontValidatorResolver: FontValidatorResolver,
        private readonly tempDir: string = configValue("tempDir"),
    ) {}

    public async convert(params: ConvertParams): Promise<string> {
        const originExtension = (await FileHelper.getFileExtension(params.originPath)).toLowerCase();

        if (originExtension === params.extension) {
            throw new FontConvertorError("New and old font extension cannot be equal.");
        }

        const newFontPath = await FileHelper.createDatedFilePath(this.tempDir, params.extension);

        try {
            const convertor = this.convertorFactory.get(originExtension as Extension, params.extension);
            await convertor.convert(params.originPath, newFontPath);
            // The engine can exit with 0 and leave nothing or not a font: past the 65 535 glyphs of
            // sfnt fontforge 20230101 writes a TTF of 0 bytes. So the result meets the validator a
            // source of its format meets.
            await this.fontValidatorResolver.get(params.extension).validate(newFontPath);
        } catch (error) {
            throw FontConvertorError.byError(error);
        }

        return newFontPath;
    }
}
