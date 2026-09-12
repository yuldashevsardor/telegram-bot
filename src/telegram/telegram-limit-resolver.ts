import { injectable } from "inversify";
import { configValue } from "app/common/config-value";
import { LimitResolver } from "app/telegram/outbound-queue/limit-resolver";
import { Limit } from "app/telegram/outbound-queue/rate-limit.types";
import { Task } from "app/telegram/outbound-queue/task";
import { TelegramLimits } from "app/infrastructure/config/config-container";
import { isGroupChat } from "app/telegram/telegram-chat";

@injectable()
export class TelegramLimitResolver implements LimitResolver {
    public constructor(private readonly limits: TelegramLimits = configValue("limits")) {}

    public resolve(task: Task): Limit {
        // Ключ партиции здесь — chat ID; нечисловой ключ до очереди в боте не доходит, но и он
        // получит приватный лимит, а не исключение: Number("abc") даёт NaN, и сравнение ложно.
        return isGroupChat(Number(task.key)) ? this.limits.group : this.limits.private;
    }
}
