import { Bot as TelegramBot, Composer } from "grammy";
import { inject, injectable } from "inversify";
import { Config } from "App/Config/Config";
import { Infrastructure } from "App/Config/Dependency/Symbols/Infrastructure";
import { Modules } from "App/Config/Dependency/Symbols/Modules";
import { Planner } from "App/Modules/Planner/Planner";
import { Broker } from "App/Modules/Broker/Broker";
import { Context } from "App/Modules/Bot/Context";
import { sleep } from "App/Helpers/Utils";
import { container } from "App/Config/Dependency/Container";
import { Command } from "App/Modules/Bot/Command/Command";
import { Middleware } from "App/Modules/Bot/Middleware/Middleware";

@injectable()
export class Bot {
    public readonly bot: TelegramBot;

    private isRun = false;
    private isConfigured = false;

    public constructor(
        @inject<Config>(Infrastructure.Config) private readonly config: Config,
        @inject<Planner>(Modules.Planner.Planner) private readonly planner: Planner,
        @inject<Broker>(Modules.Broker.Broker) private readonly broker: Broker,
    ) {
        const botToken = this.config.bot.token;
        if (!botToken) {
            throw new Error("Bot token cannot be empty!");
        }

        this.bot = new TelegramBot<Context>(botToken, {
            ContextConstructor: Context,
        });
    }

    public async run(): Promise<void> {
        try {
            await this.broker.run();
            await this.configure();

            this.bot.start().catch(this.handleError.bind(this));
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

        this.configureMiddlewares();
        this.configureCommands();

        this.isConfigured = true;
    }

    private configureCommands(): void {
        const commands = Object.values(Modules.Bot.Command).map((symbol) => {
            return container.get<Command>(symbol);
        });

        const composer = new Composer<Context>();

        for (const command of commands) {
            command.initialize(composer);
        }

        this.bot.use(composer);
    }

    private configureMiddlewares(): void {
        const composer = new Composer<Context>();
        const middlewares = [
            container.get<Middleware>(Modules.Bot.Middleware.AsyncLocalStorage),
            container.get<Middleware>(Modules.Bot.Middleware.ResponseTime),
            container.get<Middleware>(Modules.Bot.Middleware.RequestLog),
        ];

        for (const middleware of middlewares) {
            middleware.initialize(composer);
        }

        this.bot.use(composer);
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
