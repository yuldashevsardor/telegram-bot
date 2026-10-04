import { injectable } from "inversify";
import { IdArgumentsValidator } from "app/telegram/cli-command/id-arguments-validator";

// The arguments of the commands over a chat of the outbox: `<chatId>`.
@injectable()
export class OutboxArgumentsValidator extends IdArgumentsValidator {
    public constructor() {
        super("<chatId>");
    }

    public validate(args: readonly string[]): { chatId: number } {
        const [chatId] = this.parseIds(args, 1);

        return { chatId: chatId as number };
    }
}
