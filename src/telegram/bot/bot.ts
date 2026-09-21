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

// The getUpdates default is every type but chat_member and reactions. The bot serves only
// commands and a conversation wait() in private chats, that is a single message type: the
// rest would reach the filters and be dropped, having paid for the network, the middleware
// and a user write. A file sent by a user is a message too, with a document inside:
// allowed_updates lists update types, not the contents of a message, so accepting fonts does
// not widen the list. The list is not a defence: Telegram applies it on its side, and updates
// of the old types accumulated before the change can still arrive.
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

        // Filters above everything else: both need no more than ctx.from and ctx.chat, while
        // session() already reads the row on the way in and writes it back on the way out — a
        // group update does have a session key, so, dropped below, it would still have left a
        // row in the database; an update that is dropped needs the queue even less. The order
        // inside the list matters: IsPrivateChat drops silently and does so without chat as
        // well, so updates without a session key must be seen first by HasSessionKey with its
        // warning.
        await this.setupFilters([this.hasSessionKeyFilter, this.isPrivateChatFilter]);
        // sequentialize() strictly above session(): session() is not lazy — it reads the row
        // before next() and writes it after the return, so only the middle of the chain would
        // end up under the queue while the read and the write themselves stayed outside. Two
        // updates of one user would then read the same state, and the second would write its
        // own over the first — losing both requestCount and the conversation step, which
        // conversations keeps in the same session.
        await this.setupSequential();
        await this.setupSession();
        await this.setupMiddlewares();
        // Fluent is needed by the commands too: their descriptions are translated by the same
        // instance before they go to setMyCommands.
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

    // The queue key is the same getSessionKey that session() gets: what has to be serialized is
    // exactly the updates of one sessions row. It protects the check-then-act in
    // FillUserToContextMiddleware as well: the key carries from.id, and the filters above let
    // through no chat of the user other than the private one.
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
        // The directory comes from the running code (__dirname), not from rootDir: build/
        // carries its own copies of the `.ftl` next to the code (a build step in package.json),
        // and a path from cwd would send the built application to read locales from src/, which
        // a deployment does not have. The bot lives in its own bot/ directory while the `.ftl`
        // are spread over the whole telegram/ subsystem — next to the commands and the
        // conversations, so the walk starts one level up.
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
