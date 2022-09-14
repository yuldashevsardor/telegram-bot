import { SlotManager } from "app/domain/slot-manager/slot-manager";
import { inject, injectable } from "inversify";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { Logger } from "app/domain/logger/logger";
import { Limits } from "app/domain/planner/planner.types";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";
import { Message, PRIORITY } from "app/domain/broker/broker.types";

type PlannerMessages = {
    [key in PRIORITY]: Message[];
};

@injectable()
export class Planner {
    @ConfigValue<Limits>("managerLimits")
    private readonly limits!: Limits;

    private readonly messages: PlannerMessages;

    private readonly commonManager: SlotManager;

    private readonly managers: Map<number, SlotManager>;

    private banExpirationTime: number | null = null;

    public constructor(@inject<Logger>(Infrastructure.Logger) private readonly logger: Logger) {
        this.messages = {
            [PRIORITY.HIGH]: [],
            [PRIORITY.MEDIUM]: [],
            [PRIORITY.LOW]: [],
        };

        this.commonManager = new SlotManager(this.limits.common);
        this.managers = new Map<number, SlotManager>();
        this.logMessageCount();
        this.logBanExpires();
    }

    public push(message: Message, priority: PRIORITY): void {
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
        if (this.isBanned()) {
            return null;
        }

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
        const expirationTime = duration + Date.now();

        if (expirationTime < Date.now()) {
            return;
        }

        this.banExpirationTime = expirationTime;
    }

    private isBanned(): boolean {
        return this.banExpirationTime !== null && this.banExpirationTime >= Date.now();
    }

    private pullByPriority(priority: PRIORITY): {
        message: Message;
        manager: SlotManager;
    } | null {
        let index = 0;
        let result: {
            message: Message;
            manager: SlotManager;
        } | null = null;

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

    private getManagerByMessage(message: Message): SlotManager {
        let manager = this.managers.get(message.chatId);

        if (!manager) {
            manager = new SlotManager(message.isGroup ? this.limits.group : this.limits.private);
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
            this.logger.info(`Number of messages in the queue: ${this.getMessagesCount()}`);
        }, 10000).unref();
    }

    private logBanExpires(): void {
        setInterval(() => {
            if (this.banExpirationTime && this.isBanned()) {
                const banExpires = Math.floor((this.banExpirationTime - Date.now()) / 1000);
                console.log(`Ban expires in ${banExpires} second.`);
            }
        }, 10000).unref();
    }
}
