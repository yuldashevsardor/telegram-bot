import { injectable } from "inversify";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";
import { LimitResolver } from "app/domain/task-queue/limit-resolver";
import { Limit } from "app/domain/task-queue/rate-limit.types";
import { Task } from "app/domain/task-queue/task";
import { TelegramLimits } from "app/infrastructure/config/config-container";
import { isGroupChat } from "app/infrastructure/bot/telegram-chat";

@injectable()
export class TelegramLimitResolver implements LimitResolver {
    @ConfigValue<TelegramLimits>("limits")
    private readonly limits!: TelegramLimits;

    public resolve(task: Task): Limit {
        // Ключ партиции здесь — chat ID; нечисловой ключ до очереди в боте не доходит, но и он
        // получит приватный лимит, а не исключение: Number("abc") даёт NaN, и сравнение ложно.
        return isGroupChat(Number(task.key)) ? this.limits.group : this.limits.private;
    }
}
