import type { StorageAdapter } from "grammy";
import { Bot as TelegramBot, Composer, session } from "grammy";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Command } from "app/telegram/command/command";
import type { Middleware } from "app/telegram/middleware/middleware";
import type { BotSettings, Context } from "app/telegram/bot.types";
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
import { createFluent, createFluentMiddleware } from "app/telegram/locale";
import type { Locale } from "app/telegram/locale.types";
import { DEFAULT_LOCALE, LOCALES } from "app/telegram/locale.types";

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

        // Фильтры выше всего остального: обоим хватает ctx.from и ctx.chat, зато session()
        // уже на входе читает строку, а на выходе пишет её обратно — у группового апдейта
        // ключ сессии есть, и отброшенный ниже он всё равно оставил бы за собой запись в
        // базе; очередь отброшенному апдейту не нужна тем более. Порядок внутри списка
        // важен: IsPrivateChat отбрасывает молча и без chat тоже, поэтому апдейты без ключа
        // сессии должен раньше увидеть HasSessionKey с его warning.
        await this.setupFilters([this.hasSessionKeyFilter, this.isPrivateChatFilter]);
        // sequentialize() строго выше session(): session() не ленив — читает строку до
        // next() и пишет после возврата, поэтому под очередью оказалась бы только середина
        // цепочки, а само чтение и запись остались бы снаружи. Два апдейта одного
        // пользователя тогда прочитали бы одно состояние, и второй записал бы своё поверх
        // первого — потерялся бы и requestCount, и шаг разговора, который conversations
        // держит в той же сессии.
        await this.setupSequential();
        await this.setupSession();
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
        // Каталог берётся от запущенного кода (__dirname), а не от rootDir: в build/ рядом
        // с кодом лежат свои копии `.ftl` (шаг сборки в package.json), и путь от cwd увёл бы
        // собранное приложение читать локали из src/ — которого в развёрнутом виде нет.
        const fluent = await createFluent(__dirname);

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
        this.logger.critical("Unhandled error on bot", { cause: error });
    }
}
