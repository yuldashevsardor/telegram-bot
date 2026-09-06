import { Rate, RateLimit } from "app/domain/dispatcher/rate-limit";
import { PRIORITY, Task } from "app/domain/dispatcher/task";

type PartitionTasks = {
    [key in PRIORITY]: Task[];
};

export class Partition {
    private readonly tasks: PartitionTasks;

    private readonly rateLimit: RateLimit;

    private count = 0;

    public constructor(rate: Rate) {
        this.tasks = {
            [PRIORITY.HIGH]: [],
            [PRIORITY.MEDIUM]: [],
            [PRIORITY.LOW]: [],
        };

        this.rateLimit = new RateLimit(rate);
    }

    public push(task: Task, priority: PRIORITY): void {
        this.tasks[priority].push(task);
        this.count++;
    }

    // Резервацию делает сама партиция: лимит ключа существует только ради выдачи его задач,
    // и развести выемку и резервацию по разным вызовам значило бы позволить забрать задачу,
    // не заняв слот.
    public take(priority: PRIORITY): Task | null {
        if (!this.isFree()) {
            return null;
        }

        const task = this.tasks[priority].shift();

        if (!task) {
            return null;
        }

        this.rateLimit.reserve();
        this.count--;

        return task;
    }

    public has(priority: PRIORITY): boolean {
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
