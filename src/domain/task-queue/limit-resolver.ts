import { Limit } from "app/domain/task-queue/rate-limit.types";
import { Task } from "app/domain/task-queue/task";

// Порт: лимит есть свойство ключа, а не отдельной задачи, поэтому очередь спрашивает его один
// раз, когда заводит партицию. В порт при этом едет вся задача: по чему именно выбирается
// лимит, знает реализация на стороне того, кто очередь использует, и ключа ей может не хватить.
export interface LimitResolver {
    resolve(task: Task): Limit;
}
