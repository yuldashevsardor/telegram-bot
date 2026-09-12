import { injectable } from "inversify";
import { Chat } from "@grammyjs/types";
import { Context } from "app/telegram/bot.types";
import { Filter } from "app/telegram/filter/filter";

@injectable()
export class IsPrivateChatFilter extends Filter {
    protected handle(ctx: Context): ctx is Context & { chat: Chat.PrivateChat } {
        return ctx.chat?.type === "private";
    }
}
