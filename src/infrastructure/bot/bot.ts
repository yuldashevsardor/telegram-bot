import { Bot as TelegramBot, Composer, session, StorageAdapter } from "grammy";
import { inject, injectable } from "inversify";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { container } from "app/infrastructure/container/container";
import { Command } from "app/infrastructure/bot/command/command";
import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";
import { BotSettings, Context } from "app/infrastructure/bot/bot.types";
import { Logger } from "app/domain/logger/logger";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { FetchOptions, run, RunnerHandle, sequentialize } from "@grammyjs/runner";
import { getSessionKey, initialPayload } from "app/infrastructure/bot/session/session.helper";
import { SessionPayload } from "app/infrastructure/bot/session/session.types";
import { ConversationHandler } from "app/infrastructure/bot/conversation/conversation-handler";
import { conversations, createConversation } from "@grammyjs/conversations";
import { Filter } from "app/infrastructure/bot/filter/filter";
import { withTimeout } from "app/helper/utils";
import { InvalidConfigError, RuntimeError } from "app/common/errors";
import { Fluent } from "@moebius/fluent";
import { BotCommand } from "grammy/types";
import { createFluent, createFluentMiddleware } from "app/infrastructure/bot/locale";
import { DEFAULT_LOCALE, Locale, LOCALES } from "app/infrastructure/bot/locale.types";
import path from "path";

// Умолчание getUpdates — все типы, кроме chat_member и реакций. Бот же обслуживает
// только команды и ожидание conversation в приватных чатах, то есть один message:
// остальное дошло бы до фильтров и было отброшено, оплатив сеть, middleware и запись
// пользователя. Присланный пользователем файл — тоже message, с document внутри:
// allowed_updates перечисляет типы апдейта, а не содержимое сообщения, и на приём
// шрифтов список расширять не нужно. Список — не защита: Telegram применяет его на
// своей стороне, а накопленные апдейты старых типов после смены списка ещё могут прийти.
const ALLOWED_UPDATES: NonNullable<FetchOptions["allowed_updates"]> = ["message"];

@injectable()
export class Bot {
    public readonly grammy: TelegramBot<Context>;

    @ConfigValue<BotSettings>("bot")
    private readonly settings!: BotSettings;

    @ConfigValue<string>("rootDir")
    private readonly rootDir!: string;

    private runner?: RunnerHandle;
    private isRun = false;
    private isSetup = false;

    public constructor(
        @inject<Logger>(Infrastructure.Logger) private readonly logger: Logger,
        @inject<StorageAdapter<SessionPayload>>(Modules.Bot.Session.Storage)
        private readonly sessionStorage: StorageAdapter<SessionPayload>,
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

        // Фильтры до session(): обоим хватает ctx.from и ctx.chat, зато session() уже на
        // входе читает строку, а на выходе пишет её обратно — у группового апдейта ключ
        // сессии есть, и отброшенный ниже он всё равно оставил бы за собой запись в базе.
        // Порядок внутри списка важен: IsPrivateChat отбрасывает молча и без chat тоже,
        // поэтому апдейты без ключа сессии должен раньше увидеть HasSessionKey с его warning.
        await this.setupFilters([Modules.Bot.Filter.HasSessionKey, Modules.Bot.Filter.IsPrivateChat]);
        await this.setupSession();
        await this.setupSequential();
        await this.setupMiddlewares();
        // Fluent нужен и командам: их описания переводятся тем же экземпляром до того, как
        // уйдут в setMyCommands.
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

    private async setupMiddlewares(): Promise<void> {
        this.logger.debug("Setup middlewares...");

        const composer = new Composer<Context>();
        const middlewares = [
            container.get<Middleware>(Modules.Bot.Middleware.AsyncLocalStorage),
            container.get<Middleware>(Modules.Bot.Middleware.Mutation.TelegramCallApi),
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

    private async setupFlavor(): Promise<Fluent> {
        const fluent = await createFluent(path.join(this.rootDir, "src", "infrastructure", "bot"));

        this.grammy.use(createFluentMiddleware(fluent));

        return fluent;
    }

    private async setupFilters(symbols: symbol[]): Promise<void> {
        this.logger.debug("Setup filters...", { filters: symbols.map(String) });

        const composer = new Composer<Context>();

        for (const symbol of symbols) {
            container.get<Filter>(symbol).setup(composer);
        }

        this.grammy.use(composer);

        this.logger.debug("Filters successfully setup.");
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

    private async setupCommands(fluent: Fluent): Promise<void> {
        this.logger.debug("Setup commands...");

        const commands = Object.values(Modules.Bot.Command).map((symbol) => {
            return container.get<Command>(symbol);
        });

        const composer = new Composer<Context>();

        for (const command of commands) {
            command.setup(composer);
        }

        // Набор без language_code — запасной: его Telegram показывает всем, чей язык не
        // совпал ни с одним из заданных ниже, поэтому он идёт на дефолтной локали.
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
        this.logger.critical("Unhandled error on bot", { error: error });
    }
}
