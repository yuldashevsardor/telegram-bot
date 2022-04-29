import { CommonSlotManager } from "../broker/slot-manager/CommonSlotManager";
import { GroupSlotManager } from "../broker/slot-manager/GroupSlotManager";
import { UserSlotManager } from "../broker/slot-manager/UserSlotManager";
import { DEFAULT_PRIORITY, Message, PRIORITY } from "../broker/Message";
import { SlotManager } from "../broker/slot-manager/SlotManager";
import { PlannerAlreadyCreatedError } from "./Errors";

type PlannerMessages = {
    [key in PRIORITY]: Message[];
};

let alreadyCreated = false;

export class Planner {
    private readonly messages: PlannerMessages;

    private readonly commonManager: CommonSlotManager;

    private readonly managers: Map<number, SlotManager>;

    private constructor() {
        this.messages = {
            [PRIORITY.HIGH]: [],
            [PRIORITY.MEDIUM]: [],
            [PRIORITY.LOW]: [],
        };

        this.commonManager = CommonSlotManager.build();
        this.managers = new Map<number, SlotManager>();
        this.logMessageCount();
    }

    public push(message: Message, priority: PRIORITY = DEFAULT_PRIORITY): void {
        switch (priority) {
            case PRIORITY.HIGH:
                this.messages.HIGH.push(message);
                break;
            case PRIORITY.MEDIUM:
                this.messages.MEDIUM.push(message);
                break;
            default:
                this.messages.LOW.push(message);
        }
    }

    public pull(): Message | null {
        if (this.isEmpty()) {
            return null;
        }

        if (!this.commonManager.isFree()) {
            return null;
        }

        const priorities = Object.keys(this.messages);

        for (const priority of priorities) {
            const messageAndManager = this.pullByPriority(priority as PRIORITY);

            if (messageAndManager) {
                this.commonManager.reserve();
                messageAndManager.manager.reserve();
                return messageAndManager.message;
            }
        }

        return null;
    }

    public isEmpty(): boolean {
        return this.messages.HIGH.length === 0 && this.messages.MEDIUM.length === 0 && this.messages.LOW.length === 0;
    }

    public ban(duration: number): void {
        this.commonManager.ban(Date.now() + duration);
    }

    private pullByPriority(priority: PRIORITY): {
        message: Message;
        manager: SlotManager;
    } | null {
        let result = null;
        let index = 0;

        while (index < this.messages[priority].length) {
            const message = this.messages[priority][index];
            const manager = this.getManagerByMessage(message);

            if (manager.isFree()) {
                result = {
                    message: message,
                    manager: manager,
                };
                break;
            }
            index++;
        }

        if (result) {
            this.messages[priority].splice(index, 1);
        }

        return result;
    }

    private getManagerByMessage(message: Message): GroupSlotManager {
        let manager = this.managers.get(message.chatId);

        if (!manager) {
            manager = message.isGroup ? GroupSlotManager.build() : UserSlotManager.build();

            this.managers.set(message.chatId, manager);
        }

        return manager;
    }

    public getMessagesCount(): number {
        let count = 0;

        for (const messages of Object.values(this.messages)) {
            count += messages.length;
        }

        return count;
    }

    private logMessageCount(): void {
        setInterval(() => {
            console.log(`Number of messages in the queue: ${this.getMessagesCount()}`);
        }, 10000).unref();
    }

    public static create(): Planner {
        if (alreadyCreated) {
            throw new PlannerAlreadyCreatedError();
        }

        const planner = new Planner();
        alreadyCreated = true;

        return planner;
    }
}

export const plannerInstance = Planner.create();
