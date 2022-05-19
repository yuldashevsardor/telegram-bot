import { ConvertParams, Format } from "./Types";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { InvalidFormat, PermissionDenied } from "./Errors";
import { tempDir } from "../../config";

export class FontConvertor {
    private readonly allowedFormats = Object.values(Format);

    private readonly commandLayout: string = `{PYTHON} -c "
        from fontTools.ttLib import TTFont; 
        f = TTFont('{SRC}');
        f.flavor='{FORMAT}';
        f.save('{DIST}')"
        `;

    public async prepare(): Promise<void> {
        await FontConvertor.checkReadAccess(tempDir);
        await FontConvertor.checkWriteAccess(tempDir);
    }

    private static async checkReadAccess(path: string): Promise<void> {
        try {
            await fs.access(path, fsSync.constants.R_OK);
        } catch (error) {
            PermissionDenied.read(path);
        }
    }

    private static async checkWriteAccess(path: string): Promise<void> {
        try {
            await fs.access(path, fsSync.constants.W_OK);
        } catch (error) {
            PermissionDenied.write(path);
        }
    }

    public async convert(params: ConvertParams): Promise<string> {
        await FontConvertor.checkReadAccess(params.path);
        await FontConvertor.checkWriteAccess(params.path);

        const srcFormat = params.path.split(".").pop();

        if (!this.allowedFormats.includes(srcFormat as Format)) {
            InvalidFormat.byFilePath(params.path);
        }

        if (srcFormat === params.format) {
            throw new InvalidFormat("Font new format must be different");
        }

        return "";
    }

    public composeConvertCommand(params: string): string {
        return "";
    }
}
