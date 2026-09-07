import { injectable } from "inversify";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";
import { LimitResolver } from "app/domain/task-queue/limit-resolver";
import { Limit } from "app/domain/task-queue/rate-limit.types";
import { Task } from "app/domain/task-queue/task";
import { TelegramLimits } from "app/infrastructure/config/config";
import { isGroupChat } from "app/infrastructure/bot/telegram-chat";

// Реализация порта LimitResolver для бота: ключ партиции — это chat ID, и лимит у группы свой.
@injectable()
export class TelegramLimitResolver implements LimitResolver {
    @ConfigValue<TelegramLimits>("limits")
    private readonly limits!: TelegramLimits;

    public resolve(task: Task): Limit {
        return typeof task.key === "number" && isGroupChat(task.key) ? this.limits.group : this.limits.private;
    }
}
