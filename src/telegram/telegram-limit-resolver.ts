import { injectable } from "inversify";
import { configValue } from "app/shared/config-value";
import type { LimitResolver } from "app/telegram/outbound-queue/limit-resolver";
import type { Limit } from "app/telegram/outbound-queue/rate-limit/rate-limit.types";
import type { Task } from "app/telegram/outbound-queue/task";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import { isGroupChat } from "app/telegram/telegram-chat";

@injectable()
export class TelegramLimitResolver implements LimitResolver {
    public constructor(private readonly limits: TelegramLimits = configValue("limits")) {}

    public resolve(task: Task): Limit {
        // The partition key here is a chat ID; a non-numeric key never reaches the queue in the bot,
        // but even it gets the private limit rather than an exception: Number("abc") gives NaN, and
        // the comparison is false.
        return isGroupChat(Number(task.key)) ? this.limits.group : this.limits.private;
    }
}
