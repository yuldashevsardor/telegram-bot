import { Limit } from "app/domain/task-queue/rate-limit.types";
import { PartitionKey } from "app/domain/task-queue/task";

// Порт: лимит — свойство ключа, а не отдельной задачи, поэтому очередь спрашивает его один раз,
// когда заводит партицию. Что именно делает ключ групповым или приватным, знает реализация на
// стороне того, кто очередь использует.
export interface LimitResolver {
    resolve(key: PartitionKey): Limit;
}
