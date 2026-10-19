import type { StorageAdapter } from "grammy";
import { Bot as TelegramBot, Composer, GrammyError, session } from "grammy";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Command } from "app/telegram/command/command";
import type { Middleware } from "app/telegram/middleware/middleware";
import type { BotSettings, Context } from "app/telegram/bot/bot.types";
import type { Logger } from "app/platform/logger/logger";
import { getSessionKey, initialPayload } from "app/telegram/session/session.helper";
import type { SessionPayload } from "app/telegram/session/session.types";
import type { Filter } from "app/telegram/filter/filter";
import { InvalidConfigError } from "app/shared/errors";
import type { Fluent } from "@moebius/fluent";
import type { BotCommand, BotCommandScope } from "grammy/types";
import { createFluentMiddleware } from "app/telegram/locale/locale";
import type { Locale } from "app/telegram/locale/locale.types";
import { DEFAULT_LOCALE, LOCALES } from "app/telegram/locale/locale.types";
import type { OutboxTransformer } from "app/telegram/outbox/transformer/outbox-transformer";
import type { BulkMessagesCommand } from "app/telegram/command/bulk-messages/bulk-messages.command";
import type { SupportedFormats } from "app/telegram/supported-formats";

// What Telegram answers a menu of a chat that has not opened the bot.
const CHAT_NOT_FOUND_DESCRIPTION = "Bad Request: chat not found";

@injectable()
export class Bot {
    public readonly grammy: TelegramBot<Context>;

    private isSetup = false;

    public constructor(
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        @inject<StorageAdapter<SessionPayload>>(Tokens.Bot.Session.Storage)
        private readonly sessionStorage: StorageAdapter<SessionPayload>,
        @inject<OutboxTransformer>(Tokens.Bot.Outbox.Transformer) private readonly outboxTransformer: OutboxTransformer,
        @inject<Fluent>(Tokens.Bot.Fluent) private readonly fluent: Fluent,
        @inject<Filter>(Tokens.Bot.Filter.HasSessionKey) private readonly hasSessionKeyFilter: Filter,
        @inject<Filter>(Tokens.Bot.Filter.IsPrivateChat) private readonly isPrivateChatFilter: Filter,
        @inject<Middleware>(Tokens.Bot.Middleware.RequestContext) private readonly requestContextMiddleware: Middleware,
        @inject<Middleware>(Tokens.Bot.Middleware.ResponseTime) private readonly responseTimeMiddleware: Middleware,
        @inject<Middleware>(Tokens.Bot.Middleware.RequestLog) private readonly requestLogMiddleware: Middleware,
        @inject<Middleware>(Tokens.Bot.Middleware.FillUserToContext) private readonly fillUserToContextMiddleware: Middleware,
        @inject<Command>(Tokens.Bot.Command.Start) private readonly startCommand: Command,
        @inject<Command>(Tokens.Bot.Command.Help) private readonly helpCommand: Command,
        @inject<BulkMessagesCommand>(Tokens.Bot.Command.BulkMessages) private readonly bulkMessagesCommand: BulkMessagesCommand,
        @inject<Middleware>(Tokens.Bot.Middleware.UnknownCommand) private readonly unknownCommandMiddleware: Middleware,
        @inject<Middleware>(Tokens.Bot.Middleware.NotAFile) private readonly notAFileMiddleware: Middleware,
        @inject<Middleware>(Tokens.Bot.Middleware.FileIntake) private readonly fileIntakeMiddleware: Middleware,
        @inject<Middleware>(Tokens.Bot.Middleware.Conversion) private readonly conversionMiddleware: Middleware,
        @inject<SupportedFormats>(Tokens.Bot.SupportedFormats) private readonly supportedFormats: SupportedFormats,
        private readonly settings: BotSettings = configValue("bot"),
    ) {
        if (!this.settings.token) {
            throw new InvalidConfigError("Bot token cannot be empty!");
        }

        this.grammy = new TelegramBot<Context>(this.settings.token);
    }

    public async setup(): Promise<void> {
        if (this.isSetup) {
            return;
        }

        // First: grammY copies the transformers of bot.api into the Api of an update when the update
        // comes, so one installed after an update would miss its calls.
        this.grammy.api.config.use(this.outboxTransformer.transform);

        // Filters first: they need no more than ctx.from and ctx.chat, and a group update dropped
        // below session() would still leave a row. HasSessionKey before IsPrivateChat, which drops
        // an update without chat silently (docs/architecture/bot.md, steps 1-2).
        await this.setupFilters([this.hasSessionKeyFilter, this.isPrivateChatFilter]);
        await this.setupSession();
        await this.setupMiddlewares([
            this.requestContextMiddleware,
            this.responseTimeMiddleware,
            this.requestLogMiddleware,
            this.fillUserToContextMiddleware,
        ]);
        // Above the commands: they translate with ctx.t.
        await this.setupFlavor();
        await this.setupDescriptions();
        await this.setupCommands();
        // Below the commands, for what none of them took: an unknown command first, so that it does
        // not get the hint for a text, and the hint before the file, so that a GIF, which Telegram
        // puts into document as well, gets the hint. A press of a format button is no message, and
        // the three pass it on to the conversion.
        await this.setupMiddlewares([
            this.unknownCommandMiddleware,
            this.notAFileMiddleware,
            this.fileIntakeMiddleware,
            this.conversionMiddleware,
        ]);

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

    private async setupMiddlewares(middlewares: Middleware[]): Promise<void> {
        this.logger.debug("Setup middlewares...", { middlewares: middlewares.map((middleware) => middleware.constructor.name) });

        const composer = new Composer<Context>();

        for (const middleware of middlewares) {
            middleware.setup(composer);
        }

        this.grammy.use(composer);

        this.logger.debug("Middlewares successfully setup.");
    }

    private async setupFlavor(): Promise<void> {
        this.grammy.use(createFluentMiddleware(this.fluent));
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

    private async setupCommands(): Promise<void> {
        this.logger.debug("Setup commands...");

        const commonCommands = [this.startCommand, this.helpCommand];
        // The menu of a chat replaces the common one there rather than adding to it, so it repeats
        // the common commands.
        const chatCommands = [...commonCommands, this.bulkMessagesCommand];

        const composer = new Composer<Context>();

        for (const command of chatCommands) {
            command.setup(composer);
        }

        await this.publishCommands(commonCommands, { type: "default" });

        for (const chatId of this.bulkMessagesCommand.chatIds) {
            await this.publishChatCommands(chatCommands, chatId);
        }

        this.grammy.use(composer);

        this.logger.debug("Commands successfully setup.");
    }

    // A chat that has not opened this bot keeps the common menu: the chats are the owner's
    // accounts, and the bot of a development slot may not have been opened by all of them.
    private async publishChatCommands(commands: Command[], chatId: number): Promise<void> {
        try {
            await this.publishCommands(commands, { type: "chat", chat_id: chatId });
        } catch (error) {
            if (!(error instanceof GrammyError) || error.description !== CHAT_NOT_FOUND_DESCRIPTION) {
                throw error;
            }

            this.logger.warning("The chat has not opened the bot and keeps the common menu.", { chatId: chatId });
        }
    }

    private async publishCommands(commands: Command[], scope: BotCommandScope): Promise<void> {
        // The set without language_code is the fallback: Telegram shows it to everyone whose
        // language matched none of those set below, so it goes in the default locale.
        await this.grammy.api.setMyCommands(this.describeCommands(commands, DEFAULT_LOCALE), { scope: scope });

        for (const locale of LOCALES) {
            if (locale === DEFAULT_LOCALE) {
                continue;
            }

            await this.grammy.api.setMyCommands(this.describeCommands(commands, locale), {
                scope: scope,
                language_code: locale,
            });
        }
    }

    // What an empty chat with the bot shows before /start, and its profile. The fallback goes
    // without language_code, as for the commands.
    private async setupDescriptions(): Promise<void> {
        const formats = this.supportedFormats.toText();

        for (const locale of LOCALES) {
            const translate = this.fluent.withLocale(locale);
            const localeOptions = locale === DEFAULT_LOCALE ? {} : { language_code: locale };
            const description = translate("bot-description", { formats: formats, contact: this.settings.authorContact });

            await this.grammy.api.setMyDescription(description, localeOptions);
            await this.grammy.api.setMyShortDescription(translate("bot-short-description", { formats: formats }), localeOptions);
        }
    }

    private describeCommands(commands: Command[], locale: Locale): BotCommand[] {
        const translate = this.fluent.withLocale(locale);

        return commands.map((command) => {
            return {
                command: command.command,
                description: translate(command.descriptionKey),
            };
        });
    }
}
