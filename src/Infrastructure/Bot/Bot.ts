import { Bot as TelegramBot, Composer } from "grammy";
import { inject, injectable } from "inversify";
import { Modules } from "App/Infrastructure/Container/Symbols/Modules";
import { Planner } from "App/Domain/Planner/Planner";
import { Broker } from "App/Domain/Broker/Broker";
import { Context } from "App/Infrastructure/Bot/Context";
import { sleep } from "App/Helper/Utils";
import { container } from "App/Infrastructure/Container/Container";
import { Command } from "App/Infrastructure/Bot/Command/Command";
import { Middleware } from "App/Infrastructure/Bot/Middleware/Middleware";
import { ConfigValue } from "App/Infrastructure/Config/ConfigValue";
import { BotSettings } from "App/Infrastructure/Bot/Types";
import { Logger } from "App/Domain/Logger/Logger";
import { Infrastructure } from "App/Infrastructure/Container/Symbols/Infrastructure";

@injectable()
export class Bot {
    public readonly grammy: TelegramBot<Context>;

    @ConfigValue<BotSettings>("bot")
    private readonly settings!: BotSettings;

    private isRun = false;
    private isConfigured = false;

    public constructor(
        @inject<Planner>(Modules.Planner.Planner) private readonly planner: Planner,
        @inject<Logger>(Infrastructure.Logger) private readonly logger: Logger,
        @inject<Broker>(Modules.Broker.Broker) private readonly broker: Broker,
    ) {
        if (!this.settings.token) {
            throw new Error("Bot token cannot be empty!");
        }

        this.grammy = new TelegramBot<Context>(this.settings.token, {
            ContextConstructor: Context,
        });
    }

    public async run(): Promise<void> {
        try {
            await this.broker.run();
            await this.configure();

            this.grammy.catch(this.handleError.bind(this));
            await this.grammy.start({
                limit: 100,
                timeout: 1,
            });
            this.isRun = true;

            this.logger.info("Bot is successfully started.");
        } catch (error) {
            if (this.broker.isRun) {
                this.broker.stop();
            }

            await this.handleError(error);
        }
    }

    public async stop(): Promise<void> {
        this.logger.info("Stop bot...");

        await this.grammy.stop();
        await this.waitPlannerToEmpty();
        this.broker.stop();

        this.logger.info("Bot is successfully stopped.");
    }

    private async configure(): Promise<void> {
        if (this.isConfigured) {
            return;
        }

        // await this.configureMiddlewares();
        await this.configureCommands();

        this.isConfigured = true;
    }

    private async configureCommands(): Promise<void> {
        this.logger.debug("Configure commands...");

        const commands = Object.values(Modules.Bot.Command).map((symbol) => {
            return container.get<Command>(symbol);
        });

        const composer = new Composer<Context>();

        for (const command of commands) {
            command.initialize(composer);
        }

        await this.grammy.api.setMyCommands(commands);

        this.grammy.use(composer);

        this.logger.debug("Commands successfully configured.");
    }

    private async configureMiddlewares(): Promise<void> {
        this.logger.debug("Configure middlewares...");

        const composer = new Composer<Context>();
        const middlewares = [
            container.get<Middleware>(Modules.Bot.Middleware.AsyncLocalStorage),
            container.get<Middleware>(Modules.Bot.Middleware.ResponseTime),
            container.get<Middleware>(Modules.Bot.Middleware.RequestLog),
            container.get<Middleware>(Modules.Bot.Middleware.OnlyPrivateChat),
            // container.get<Middleware>(Modules.Bot.Middleware.FillUserToContext),
        ];

        for (const middleware of middlewares) {
            middleware.initialize(composer);
        }

        this.grammy.use(composer);

        this.logger.debug("Middlewares successfully configured.");
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
        this.logger.critical("Unhandled error on bot", error);
    }
}
