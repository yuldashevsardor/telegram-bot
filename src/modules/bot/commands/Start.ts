import { CommandHandler } from "../Types";
import path from "path";
import { root } from "../../../config";
import { fontConvertor } from "../../../services/font-convertor/FontConvertor";
import { Extension } from "../../../services/font-convertor/Types";
import dayjs from "dayjs";

export const command = "start";

export const handler: CommandHandler = async (ctx) => {
    for (let i = 0; i < 100; i++) {
        try {
            const start = dayjs();
            const ttfPath = path.join(root, "temp", "test-font.woffl");
            const woffPath = await fontConvertor.convert({
                originPath: ttfPath,
                extension: Extension.WOFF,
            });

            const woff2Path = await fontConvertor.convert({
                originPath: ttfPath,
                extension: Extension.WOFF2,
            });

            const diff = dayjs().diff(start, "millisecond");
            console.log(`convert woff to woff2 time: ${diff}ms`);
        } catch (error) {
            console.error(error);
        }
    }
};
