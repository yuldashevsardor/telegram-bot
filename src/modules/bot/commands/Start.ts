import { CommandHandler } from "../Types";
import { generateRandomString } from "../../../utils/string";

export const command = "start";

export const handler: CommandHandler = async (ctx) => {
    for (let i = 0; i < 100; i++) {
        ctx.reply(generateRandomString(500));
    }
};
