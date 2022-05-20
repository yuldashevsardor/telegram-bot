import { Extension } from "./Types";
import { pythonPath } from "../../config";
import { promisify } from "util";
import { exec as execOrigin } from "child_process";
import { FontConvertorError } from "./Errors";

export class FontConvertorHelper {
    private static readonly pythonFontToolsCommandLayout: string = `{PYTHON} -c "from fontTools.ttLib import TTFont;f = TTFont('{SRC}');f.flavor='{FORMAT}';f.save('{DIST}')"`;

    private static readonly pythonFontToolsCommandVariableNames = {
        src: "{SRC}",
        format: "{FORMAT}",
        dist: "{DIST}",
        python: "{PYTHON}",
    };

    static async convertViaPythonFontTools(src: string, dist: string, extension: Extension): Promise<void> {
        const command = FontConvertorHelper.pythonFontToolsCommandLayout
            .replace(FontConvertorHelper.pythonFontToolsCommandVariableNames.python, pythonPath)
            .replace(FontConvertorHelper.pythonFontToolsCommandVariableNames.src, src)
            .replace(FontConvertorHelper.pythonFontToolsCommandVariableNames.dist, dist)
            .replace(FontConvertorHelper.pythonFontToolsCommandVariableNames.format, extension);

        const exec = promisify(execOrigin);
        try {
            await exec(command);
        } catch (error) {
            throw new FontConvertorError(`Error on execute python fonttols command. Error message: ${error.message}`);
        }
    }
}
