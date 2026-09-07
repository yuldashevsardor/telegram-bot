import { injectable } from "inversify";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";
import { LimitResolver } from "app/domain/task-queue/limit-resolver";
import { Limit } from "app/domain/task-queue/rate-limit.types";
import { PartitionKey } from "app/domain/task-queue/task";
import { TelegramLimits } from "app/infrastructure/config/config";

// Отрицательный chat ID — соглашение Telegram для групп и супергрупп. Признак живёт здесь
// одним местом: им пользуются и резолвер лимита, и белый список методов в TelegramCallApiMiddleware.
export function isGroupChat(chatId: number): boolean {
    return chatId < 0;
}

// Реализация порта LimitResolver для бота: ключ партиции — это chat ID, и лимит у группы свой.
@injectable()
export class TelegramLimitResolver implements LimitResolver {
    @ConfigValue<TelegramLimits>("limits")
    private readonly limits!: TelegramLimits;

    public resolve(key: PartitionKey): Limit {
        return typeof key === "number" && isGroupChat(key) ? this.limits.group : this.limits.private;
    }
}
