import { Limit } from "app/domain/task-queue/rate-limit.types";
import { Task } from "app/domain/task-queue/task";

// Порт: лимит принадлежит партиции, поэтому очередь спрашивает его один раз — когда заводит её
// по первой задаче ключа. Правило, по которому лимит выбирается, принадлежит той стороне, что
// очередь использует, и опереться может на что угодно из задачи, поэтому сюда едет вся задача,
// а не только ключ.
export interface LimitResolver {
    resolve(task: Task): Limit;
}
