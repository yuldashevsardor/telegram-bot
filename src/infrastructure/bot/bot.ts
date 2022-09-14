import { Bot as TelegramBot, Composer, session, StorageAdapter } from "grammy";
import { inject, injectable } from "inversify";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { Planner } from "app/domain/planner/planner";
import { Broker } from "app/domain/broker/broker";
import { sleep } from "app/helper/utils";
import { container } from "app/infrastructure/container/container";
import { Command } from "app/infrastructure/bot/command/command";
import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";
import { BotSettings, Context } from "app/infrastructure/bot/bot.types";
import { Logger } from "app/domain/logger/logger";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { run, RunnerHandle, sequentialize } from "@grammyjs/runner";
import { getSessionKey, initialPayload } from "app/infrastructure/bot/session/session.helper";
import { SessionPayload } from "app/infrastructure/bot/session/session.types";
import { ConversationHandler } from "app/infrastructure/bot/conversation/conversation-handler";
import { conversations, createConversation } from "@grammyjs/conversations";
import { Filter } from "app/infrastructure/bot/filter/filter";

@injectable()
export class Bot {
    public readonly grammy: TelegramBot<Context>;

    @ConfigValue<BotSettings>("bot")
    private readonly settings!: BotSettings;

    private runner?: RunnerHandle;
    private isRun = false;
    private isSetup = false;

    public constructor(
        @inject<Planner>(Modules.Planner.Planner) private readonly planner: Planner,
        @inject<Logger>(Infrastructure.Logger) private readonly logger: Logger,
        @inject<Broker>(Modules.Broker.Broker) private readonly broker: Broker,
        @inject<StorageAdapter<SessionPayload>>(Modules.Bot.Session.Storage)
        private readonly sessionStorage: StorageAdapter<SessionPayload>,
    ) {
        if (!this.settings.token) {
            throw new Error("Bot token cannot be empty!");
        }

        this.grammy = new TelegramBot<Context>(this.settings.token);
    }

    public async run(): Promise<void> {
        try {
            await this.broker.run();
            await this.setup();

            this.grammy.catch(this.handleError.bind(this));
            this.runner = run(this.grammy);
            this.isRun = true;

            this.logger.info("Bot is successfully started.");
        } catch (error) {
            this.broker.stop();

            await this.handleError(error);
        }
    }

    public async stop(): Promise<void> {
        this.logger.info("Stop bot...");

        if (!this.isRun) {
            this.logger.info("Bot is not running!");
            return;
        }

        if (this.runner?.isRunning) {
            await this.runner.stop();
        }

        await this.waitPlannerToEmpty();
        await this.broker.stop();

        this.isRun = false;

        this.logger.info("Bot is successfully stopped.");
    }

    private async setup(): Promise<void> {
        if (this.isSetup) {
            return;
        }

        await this.setupSession();
        await this.setupSequential();
        await this.setupMiddlewares();
        await this.setupFilters();
        await this.setupConversations();
        await this.setupCommands();

        this.isSetup = true;
    }

    private async setupCommands(): Promise<void> {
        this.logger.debug("Setup commands...");

        const commands = Object.values(Modules.Bot.Command).map((symbol) => {
            return container.get<Command>(symbol);
        });

        const composer = new Composer<Context>();

        for (const command of commands) {
            command.setup(composer);
        }

        await this.grammy.api.setMyCommands(commands);

        this.grammy.use(composer);

        this.logger.debug("Commands successfully setup.");
    }

    private async setupFilters(): Promise<void> {
        this.logger.debug("Setup filters...");

        const composer = new Composer<Context>();
        const filters = [container.get<Filter>(Modules.Bot.Filter.IsPrivateChat)];

        for (const filter of filters) {
            filter.setup(composer);
        }

        this.grammy.use(composer);

        this.logger.debug("Filters successfully setup.");
    }

    private async setupMiddlewares(): Promise<void> {
        this.logger.debug("Setup middlewares...");

        const composer = new Composer<Context>();
        const middlewares = [
            container.get<Middleware>(Modules.Bot.Middleware.Mutation.TelegramCallApi),
            container.get<Middleware>(Modules.Bot.Middleware.AsyncLocalStorage),
            container.get<Middleware>(Modules.Bot.Middleware.ResponseTime),
            container.get<Middleware>(Modules.Bot.Middleware.RequestLog),
            container.get<Middleware>(Modules.Bot.Middleware.FillUserToContext),
        ];

        for (const middleware of middlewares) {
            middleware.setup(composer);
        }

        this.grammy.use(composer);

        this.logger.debug("Middlewares successfully setup.");
    }

    private async setupSession(): Promise<void> {
        this.grammy.use(
            session<unknown, Context>({
                initial: initialPayload,
                getSessionKey: getSessionKey,
                storage: this.sessionStorage,
            }),
        );
    }

    private async setupSequential(): Promise<void> {
        this.grammy.use(
            sequentialize((ctx): string[] => {
                const result: string[] = [];

                if (ctx.chat) {
                    result.push(ctx.chat.id.toString());
                }

                if (ctx.from) {
                    result.push(ctx.from.id.toString());
                }

                return result;
            }),
        );
    }

    private async setupConversations(): Promise<void> {
        this.logger.debug("Setup conversations...");

        const conversationHandlers: ConversationHandler[] = Object.values(Modules.Bot.Conversations).map((symbol) => {
            return container.get<ConversationHandler>(symbol);
        });

        this.grammy.use(conversations());

        for (const handler of conversationHandlers) {
            this.grammy.use(createConversation(handler.handle.bind(handler), handler.name));
        }

        this.logger.debug("Conversations successfully setup.");
    }

    private async waitPlannerToEmpty(): Promise<void> {
        const interval = 3000;

        // eslint-disable-next-line no-constant-condition
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
