import { ConvertParams, Extension, FontConvertorParams } from "./Types";
import path from "path";
import { FileHelper } from "../../utils/file/FileHelper";
import { InvalidPath, PermissionDenied } from "../../utils/file/Errors";
import { StringHelper } from "../../utils/StringHelper";
import { FontConvertorError } from "./Errors";
import { pythonPath, tempDir } from "../../config";
import { ConvertorFactory } from "./convertor/ConvertorFactory";

export class FontConvertor {
    private readonly tempDir: string;
    private readonly pythonPath: string;
    private isPrepared = false;

    public constructor(params: FontConvertorParams) {
        this.tempDir = params.tempDir;
        this.pythonPath = params.pythonPath;
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
        const directory = await FileHelper.createDirectoriesByData(this.tempDir);
        const newFontPath = path.join(directory, newFontFilename).toLowerCase();
        const convertorFactory = new ConvertorFactory(originExtension as Extension, params.extension);

        try {
            const convertor = convertorFactory.get();
            await convertor.convert(params.originPath, newFontPath);
        } catch (error) {
            throw new FontConvertorError(error.message);
        }

        return newFontPath;
    }
}

export const fontConvertor = new FontConvertor({
    tempDir: tempDir,
    pythonPath: pythonPath,
});
