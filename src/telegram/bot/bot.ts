import path from "path";
import type { StorageAdapter } from "grammy";
import { Bot as TelegramBot, Composer, session } from "grammy";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Command } from "app/telegram/command/command";
import type { Middleware } from "app/telegram/middleware/middleware";
import type { BotSettings, Context } from "app/telegram/bot/bot.types";
import type { Logger } from "app/platform/logger/logger";
import type { FetchOptions, RunnerHandle } from "@grammyjs/runner";
import { run, sequentialize } from "@grammyjs/runner";
import { getSessionKey, initialPayload } from "app/telegram/session/session.helper";
import type { SessionPayload } from "app/telegram/session/session.types";
import type { ConversationHandler } from "app/telegram/conversation/conversation-handler";
import { conversations, createConversation } from "@grammyjs/conversations";
import type { Filter } from "app/telegram/filter/filter";
import { withTimeout } from "app/shared/utils";
import { InvalidConfigError, RuntimeError } from "app/shared/errors";
import type { Fluent } from "@moebius/fluent";
import type { BotCommand } from "grammy/types";
import { createFluent, createFluentMiddleware } from "app/telegram/locale/locale";
import type { Locale } from "app/telegram/locale/locale.types";
import { DEFAULT_LOCALE, LOCALES } from "app/telegram/locale/locale.types";

// The bot serves only commands and a conversation wait() in private chats: a single message
// type. The getUpdates default is every type but chat_member and reactions. What the rest would
// cost, why a file does not widen the list and why it is not a defence: docs/architecture/bot.md.
const ALLOWED_UPDATES: NonNullable<FetchOptions["allowed_updates"]> = ["message"];

@injectable()
export class Bot {
    public readonly grammy: TelegramBot<Context>;

    private runner?: RunnerHandle;
    private isRun = false;
    private isSetup = false;

    public constructor(
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        @inject<StorageAdapter<SessionPayload>>(Tokens.Bot.Session.Storage)
        private readonly sessionStorage: StorageAdapter<SessionPayload>,
        @inject<Filter>(Tokens.Bot.Filter.HasSessionKey) private readonly hasSessionKeyFilter: Filter,
        @inject<Filter>(Tokens.Bot.Filter.IsPrivateChat) private readonly isPrivateChatFilter: Filter,
        @inject<Middleware>(Tokens.Bot.Middleware.RequestContext) private readonly requestContextMiddleware: Middleware,
        @inject<Middleware>(Tokens.Bot.Middleware.Mutation.TelegramCallApi) private readonly telegramCallApiMiddleware: Middleware,
        @inject<Middleware>(Tokens.Bot.Middleware.ResponseTime) private readonly responseTimeMiddleware: Middleware,
        @inject<Middleware>(Tokens.Bot.Middleware.RequestLog) private readonly requestLogMiddleware: Middleware,
        @inject<Middleware>(Tokens.Bot.Middleware.FillUserToContext) private readonly fillUserToContextMiddleware: Middleware,
        @inject<ConversationHandler>(Tokens.Bot.Conversations.Start) private readonly startConversation: ConversationHandler,
        @inject<Command>(Tokens.Bot.Command.Start) private readonly startCommand: Command,
        @inject<Command>(Tokens.Bot.Command.BulkMessages) private readonly bulkMessagesCommand: Command,
        @inject<Command>(Tokens.Bot.Command.FontGenerator) private readonly fontGeneratorCommand: Command,
        private readonly settings: BotSettings = configValue("bot"),
    ) {
        if (!this.settings.token) {
            throw new InvalidConfigError("Bot token cannot be empty!");
        }

        this.grammy = new TelegramBot<Context>(this.settings.token);
    }

    public async run(): Promise<void> {
        if (!this.isSetup) {
            throw new RuntimeError("Bot is not set up!");
        }

        this.grammy.catch(this.handleError.bind(this));
        this.runner = run(this.grammy, { runner: { fetch: { allowed_updates: ALLOWED_UPDATES } } });
        this.isRun = true;

        this.logger.info("Bot is successfully started.");
    }

    public async stop(): Promise<void> {
        this.logger.info("Stop bot...");

        if (!this.isRun) {
            this.logger.info("Bot is not running!");
            return;
        }

        const { timeout } = this.settings.gracefulShutdown;

        if (this.runner?.isRunning() && !(await withTimeout(this.runner.stop(), timeout))) {
            this.logger.warning("Bot shutdown timeout is over, the runner was left stopping.", {
                timeout: timeout,
            });
        }

        this.isRun = false;

        this.logger.info("Bot is successfully stopped.");
    }

    public async setup(): Promise<void> {
        if (this.isSetup) {
            return;
        }

        // Filters first: they need no more than ctx.from and ctx.chat. A dropped update needs
        // neither the queue nor the session row, and a group update does have a session key:
        // dropped below session(), it would still leave a row (docs/architecture/invariants.md).
        // HasSessionKey goes before IsPrivateChat: the latter drops updates without chat too,
        // but silently, so those must meet the warning of HasSessionKey first.
        await this.setupFilters([this.hasSessionKeyFilter, this.isPrivateChatFilter]);
        // sequentialize() strictly above session(): session() reads the row before next() and
        // writes it after, and below it the queue would cover neither end. Two updates of one
        // user would read the same state, and the second would write over the first, losing
        // requestCount and the conversation step (docs/architecture/invariants.md).
        await this.setupSequential();
        await this.setupSession();
        await this.setupMiddlewares();
        // The commands need Fluent too: the same instance translates their descriptions for
        // setMyCommands.
        const fluent = await this.setupFlavor();
        await this.setupConversations();
        await this.setupCommands(fluent);

        this.isSetup = true;
    }

    private async setupSession(): Promise<void> {
        this.grammy.use(
            session<SessionPayload, Context>({
                initial: initialPayload,
                getSessionKey: getSessionKey,
                storage: this.sessionStorage,
            }),
        );
    }

    // The key is the getSessionKey of session(): what must be serialized is the updates of one
    // sessions row. The key carries from.id, so it also protects the check-then-act in
    // FillUserToContextMiddleware: the filters above let through only the private chat of the
    // user (docs/architecture/invariants.md).
    private async setupSequential(): Promise<void> {
        this.grammy.use(sequentialize<Context>(getSessionKey));
    }

    private async setupMiddlewares(): Promise<void> {
        this.logger.debug("Setup middlewares...");

        const composer = new Composer<Context>();
        const middlewares = [
            this.requestContextMiddleware,
            this.telegramCallApiMiddleware,
            this.responseTimeMiddleware,
            this.requestLogMiddleware,
            this.fillUserToContextMiddleware,
        ];

        for (const middleware of middlewares) {
            middleware.setup(composer);
        }

        this.grammy.use(composer);

        this.logger.debug("Middlewares successfully setup.");
    }

    private async setupFlavor(): Promise<Fluent> {
        // From the running code (__dirname), not from rootDir: build/ has its own copies of the
        // `.ftl`, and a path from cwd would read them from src/, which a deployment does not
        // have. The walk starts one level above bot/ (docs/architecture/i18n.md).
        const fluent = await createFluent(path.dirname(__dirname));

        this.grammy.use(createFluentMiddleware(fluent));

        return fluent;
    }

    private async setupFilters(filters: Filter[]): Promise<void> {
        this.logger.debug("Setup filters...", { filters: filters.map((filter) => filter.constructor.name) });

        const composer = new Composer<Context>();

        for (const filter of filters) {
            filter.setup(composer);
        }

        this.grammy.use(composer);

        this.logger.debug("Filters successfully setup.");
    }

    private async setupConversations(): Promise<void> {
        this.logger.debug("Setup conversations...");

        const conversationHandlers = [this.startConversation];

        this.grammy.use(conversations());

        for (const handler of conversationHandlers) {
            this.grammy.use(createConversation(handler.handle.bind(handler), handler.name));
        }

        this.logger.debug("Conversations successfully setup.");
    }

    private async setupCommands(fluent: Fluent): Promise<void> {
        this.logger.debug("Setup commands...");

        const commands = [this.startCommand, this.bulkMessagesCommand, this.fontGeneratorCommand];

        const composer = new Composer<Context>();

        for (const command of commands) {
            command.setup(composer);
        }

        // The set without language_code is the fallback: Telegram shows it to everyone whose
        // language matched none of those set below, so it goes in the default locale.
        await this.grammy.api.setMyCommands(this.describeCommands(commands, fluent, DEFAULT_LOCALE));

        for (const locale of LOCALES) {
            if (locale === DEFAULT_LOCALE) {
                continue;
            }

            await this.grammy.api.setMyCommands(this.describeCommands(commands, fluent, locale), { language_code: locale });
        }

        this.grammy.use(composer);

        this.logger.debug("Commands successfully setup.");
    }

    private describeCommands(commands: Command[], fluent: Fluent, locale: Locale): BotCommand[] {
        const translate = fluent.withLocale(locale);

        return commands.map((command) => {
            return {
                command: command.command,
                description: translate(command.descriptionKey),
            };
        });
    }

    private async handleError(error: unknown): Promise<void> {
        this.logger.critical("Unhandled error on bot", { cause: error });
    }
}
