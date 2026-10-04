import { injectable } from "inversify";
import { IdArgumentsValidator } from "app/telegram/cli-command/id-arguments-validator";
import type { InboxGroupKey } from "app/telegram/inbox/store/inbox-store.types";

// The arguments of the commands over a group of the inbox: `<userId> <chatId>`.
@injectable()
export class InboxArgumentsValidator extends IdArgumentsValidator {
    public constructor() {
        super("<userId> <chatId>");
    }

    public validate(args: readonly string[]): InboxGroupKey {
        const [userId, chatId] = this.parseIds(args, 2);

        return { userId: userId as number, chatId: chatId as number };
    }
}
