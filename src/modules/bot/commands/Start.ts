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
            let start = dayjs();
            const woffPath = path.join(root, "temp", "test-font.woff");
            const woff2Path = await fontConvertor.convert({
                originPath: woffPath,
                extension: Extension.WOFF2,
            });
            let diff = dayjs().diff(start, "millisecond");
            console.log(`convert woff to woff2 time: ${diff}ms`);
            await ctx.reply(`woff2Path: ${woff2Path}`);

            start = dayjs();
            const newWoffPath = await fontConvertor.convert({
                originPath: woff2Path,
                extension: Extension.WOFF,
            });
            diff = dayjs().diff(start, "millisecond");
            console.log(`convert woff2 to woff time: ${diff}ms`);
            await ctx.reply(`woffPath: ${newWoffPath}`);
        } catch (error) {
            console.error(error);
        }
    }
};
