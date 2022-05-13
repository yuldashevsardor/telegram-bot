import { Planner, planner } from "../planner/Planner";
import * as config from "../../config";
import { Message } from "./Message";
import { BrokerAlreadyCreatedError } from "./Errors";
import { TELEGRAM_ERROR_CODES } from "./Types";

let alreadyCreated = false;

export type BrokerSettings = {
    sleepInterval: number;
};

export class Broker {
    private readonly planner: Planner;

    private readonly settings: BrokerSettings;

    private _isRun = false;

    private constructor(settings: BrokerSettings, planner: Planner) {
        this.planner = planner;
        this.settings = settings;
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
        console.log(error);

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

    public static create(planner: Planner): Broker {
        if (alreadyCreated) {
            throw new BrokerAlreadyCreatedError();
        }

        const broker = new Broker(
            {
                sleepInterval: config.broker.sleepInterval,
            },
            planner,
        );

        alreadyCreated = true;

        return broker;
    }
}

export const broker = Broker.create(planner);
