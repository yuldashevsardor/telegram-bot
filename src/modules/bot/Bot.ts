import { Bot as TelegramBot } from "grammy";
import { Context } from "./Context";
import { Planner, planner } from "../planner/Planner";
import { Broker, broker } from "../broker/Broker";
import { sleep } from "../../utils/utils";
import * as config from "../../config";
import { commands } from "./commands";

export class Bot {
    public readonly planner: Planner;
    public readonly broker: Broker;
    public readonly bot: TelegramBot;

    private isRun = false;
    private isConfigured = false;

    constructor() {
        const botToken = config.bot.token;
        if (!botToken) {
            throw new Error("Bot token cannot be empty!");
        }

        this.planner = planner;
        this.broker = broker;
        this.bot = new TelegramBot<Context>(botToken, {
            ContextConstructor: Context,
        });
    }

    public async run(): Promise<void> {
        try {
            await this.broker.run();
            await this.configure();
            await this.bot.start().catch(this.handleError.bind(this));
            this.isRun = true;
        } catch (error) {
            if (this.broker.isRun) {
                this.broker.stop();
            }

            await this.handleError(error);
        }
    }

    public async stop(): Promise<void> {
        await this.bot.stop();
        await this.waitPlannerToEmpty();
        this.broker.stop();
    }

    private async configure(): Promise<void> {
        if (this.isConfigured) {
            return;
        }

        this.bot.use(commands);

        this.isConfigured = true;
    }

    private async waitPlannerToEmpty(): Promise<void> {
        const interval = 3000;

        while (true) {
            if (this.planner.isEmpty()) {
                return;
            }

            await sleep(interval);
        }
    }

    private async handleError(error): Promise<void> {
        console.error(error);
    }
}
