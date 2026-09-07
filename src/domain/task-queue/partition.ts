import { RateLimit } from "app/domain/task-queue/rate-limit";
import { Limit } from "app/domain/task-queue/rate-limit.types";
import { Priority, Task } from "app/domain/task-queue/task";

type PartitionTasks = {
    [key in Priority]: Task[];
};

export class Partition {
    private readonly tasks: PartitionTasks;

    private readonly rateLimit: RateLimit;

    private count = 0;

    public constructor(limit: Limit) {
        this.tasks = {
            [Priority.HIGH]: [],
            [Priority.MEDIUM]: [],
            [Priority.LOW]: [],
        };

        this.rateLimit = new RateLimit(limit);
    }

    public push(task: Task, priority: Priority): void {
        this.tasks[priority].push(task);
        this.count++;
    }

    // Резервацию делает сама партиция: лимит ключа существует только ради выдачи его задач,
    // и развести выемку и резервацию по разным вызовам значило бы позволить забрать задачу,
    // не заняв слот. Обе проверки идут до выемки, поэтому reserve() здесь не бросает
    // RateLimitIsBusy: между проверкой и резервацией ничего асинхронного не происходит.
    public take(priority: Priority): Task | null {
        if (!this.has(priority) || !this.isFree()) {
            return null;
        }

        this.rateLimit.reserve();
        this.count--;

        return this.tasks[priority].shift() as Task;
    }

    public has(priority: Priority): boolean {
        return this.tasks[priority].length > 0;
    }

    public isEmpty(): boolean {
        return this.count === 0;
    }

    public isFree(): boolean {
        return this.rateLimit.isFree();
    }

    // Пустая и остывшая партиция неотличима от созданной заново, поэтому её можно удалять.
    // Пока остывание идёт, партиция и есть лимит ключа: удалив её, мы отдали бы следующую
    // задачу этого ключа немедленно, мимо лимита.
    public isIdle(): boolean {
        return this.isEmpty() && this.isFree();
    }

    public get size(): number {
        return this.count;
    }
}
