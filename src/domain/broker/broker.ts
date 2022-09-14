import { inject, injectable } from "inversify";
import { Planner } from "app/domain/planner/planner";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { BrokerSettings, Message, TELEGRAM_ERROR_CODES } from "app/domain/broker/broker.types";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";

@injectable()
export class Broker {
    @ConfigValue<BrokerSettings>("broker")
    private readonly settings!: BrokerSettings;

    private _isRun = false;

    public constructor(@inject<Planner>(Modules.Planner.Planner) private readonly planner: Planner) {}

    public run(): void {
        if (this.isRun) {
            throw new Error("broker already is run.");
        }

        this._isRun = true;

        setTimeout(this.handleMessages.bind(this), 0);
    }

    public stop(): void {
        this._isRun = false;
    }

    public get isRun(): boolean {
        return this._isRun;
    }

    private async handleMessages(): Promise<void> {
        if (!this.isRun) {
            return;
        }

        const message = this.planner.pull();

        if (!message) {
            setTimeout(this.handleMessages.bind(this), this.settings.sleepInterval);
            return;
        }

        await this.handleMessage(message);
        return this.handleMessages();
    }

    private async handleMessage(message: Message): Promise<void> {
        try {
            await message.callback();
        } catch (error) {
            this.handleError(error);
            this.planner.push(message, message.priorityOnError);
        }
    }

    private handleError(error: any): void {
        console.log("broker error", error);

        if (Broker.isManyRequestError(error)) {
            const duration = parseInt(error.parameters.retry_after) || 0;
            this.planner.ban(duration * 1000);
        }
    }

    private static isManyRequestError(error: any): boolean {
        if (!error || !error.error_code) {
            return false;
        }

        return error.error_code === TELEGRAM_ERROR_CODES.TO_MANY_REQUESTS;
    }
}
