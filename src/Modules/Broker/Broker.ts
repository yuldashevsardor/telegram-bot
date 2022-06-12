import { Message } from "App/Modules/Broker/Message";
import { inject, injectable } from "inversify";
import { Config } from "App/Config/Config";
import { Infrastructure } from "App/Config/Dependency/Symbols/Infrastructure";
import { Planner } from "App/Modules/Planner/Planner";
import { Modules } from "App/Config/Dependency/Symbols/Modules";
import { BrokerSettings, TELEGRAM_ERROR_CODES } from "App/Modules/Broker/Types";

@injectable()
export class Broker {
    private readonly settings: BrokerSettings;

    private _isRun = false;

    public constructor(
        @inject<Config>(Infrastructure.Config) private readonly config: Config,
        @inject<Planner>(Modules.Planner.Planner) private readonly planner: Planner,
    ) {
        this.settings = {
            sleepInterval: this.config.broker.sleepInterval,
        };
    }

    public run(): void {
        if (this.isRun) {
            throw new Error("Broker already is run.");
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
        console.log("Broker error", error);

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
