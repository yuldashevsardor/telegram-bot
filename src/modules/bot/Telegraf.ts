import { Telegraf as OldTelegraf } from "telegraf";
import { Context } from "./Context";
import { Planner, plannerInstance } from "../planner/Planner";
import { Broker, brokerInstance } from "../broker/Broker";
import { sleep } from "../../utils/utils";

export class Telegraf extends OldTelegraf<Context> {
    public readonly planner: Planner;
    public readonly broker: Broker;

    constructor(token: string, options?: Partial<OldTelegraf.Options<Context>>) {
        super(token, options);

        this.planner = plannerInstance;
        this.broker = brokerInstance;
    }

    public launch(config?: OldTelegraf.LaunchOptions): Promise<void> {
        this.broker.run();

        return super.launch(config);
    }

    public async stop(reason?: string): Promise<void> {
        super.stop(reason);
        await this.waitUntilPlannerIsEmpty();
        this.broker.stop();
    }

    private async waitUntilPlannerIsEmpty(): Promise<void> {
        const interval = 3000;

        while (true) {
            if (this.planner.isEmpty()) {
                return;
            }

            await sleep(interval);
        }
    }
}
