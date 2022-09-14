import { injectable } from "inversify";
import { Chat } from "@grammyjs/types";
import { Context } from "App/Infrastructure/Bot/Types";
import { Filter } from "App/Infrastructure/Bot/Filter/Filter";

@injectable()
export class IsPrivateChatFilter extends Filter {
    protected handle(ctx: Context): ctx is Context & { char: Chat.PrivateChat } {
        return ctx.chat?.type === "private";
    }
}
