import { injectable } from "inversify";
import { Chat } from "@grammyjs/types";
import { Context } from "app/infrastructure/bot/bot.types";
import { Filter } from "app/infrastructure/bot/filter/filter";

@injectable()
export class IsPrivateChatFilter extends Filter {
    protected handle(ctx: Context): ctx is Context & { char: Chat.PrivateChat } {
        return ctx.chat?.type === "private";
    }
}
