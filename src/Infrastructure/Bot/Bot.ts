import { Bot as TelegramBot, Composer } from "grammy";
import { inject, injectable } from "inversify";
import { Config } from "App/Infrastructure/Config/Config";
import { Infrastructure } from "App/Infrastructure/Config/Dependency/Symbols/Infrastructure";
import { Modules } from "App/Infrastructure/Config/Dependency/Symbols/Modules";
import { Planner } from "App/Domain/Planner/Planner";
import { Broker } from "App/Domain/Broker/Broker";
import { Context } from "App/Infrastructure/Bot/Context";
import { sleep } from "App/Infrastructure/Helpers/Utils";
import { container } from "App/Infrastructure/Config/Dependency/Container";
import { Command } from "App/Infrastructure/Bot/Command/Command";
import { Middleware } from "App/Infrastructure/Bot/Middleware/Middleware";

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
            container.get<Middleware>(Modules.Bot.Middleware.OnlyPrivateChat),
            container.get<Middleware>(Modules.Bot.Middleware.GetUserFromDb),
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
