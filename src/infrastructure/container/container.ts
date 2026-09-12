import "reflect-metadata";
import { Container as InversifyContainer } from "inversify";
import { Tokens } from "app/common/tokens";
import { ApplicationContext } from "app/infrastructure/application/application-context";
import { ConfigContainer, TelegramLimits } from "app/infrastructure/config/config-container";
import { RequestContext } from "app/infrastructure/request-context";
import { FontForge } from "app/domain/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/domain/font-convertor/font-signature-matcher";
import { EotPacker } from "app/domain/font-convertor/eot-packer/eot-packer";
import { ConvertorFactory } from "app/domain/font-convertor/convertor/convertor-factory";
import { FontConvertor } from "app/domain/font-convertor/font-convertor";
import { FontConvertorSettings } from "app/domain/font-convertor/font-convertor.types";
import { FontForgeSettings } from "app/domain/font-convertor/font-forge/font-forge.types";
import { TaskQueue } from "app/domain/task-queue/task-queue";
import { Runner } from "app/domain/task-queue/runner";
import { LimitResolver } from "app/domain/task-queue/limit-resolver";
import { Limit } from "app/domain/task-queue/rate-limit.types";
import { RunnerSettings } from "app/domain/task-queue/runner.types";
import { TelegramLimitResolver } from "app/infrastructure/bot/telegram-limit-resolver";
import { Bot } from "app/infrastructure/bot/bot";
import { BotSettings } from "app/infrastructure/bot/bot.types";
import { BulkMessagesCommand } from "app/infrastructure/bot/command/bulk-messages/bulk-messages.command";
import { FontGeneratorCommand } from "app/infrastructure/bot/command/font-generator/font-generator.command";
import { Logger } from "app/domain/logger/logger";
import { ResponseTimeMiddleware } from "app/infrastructure/bot/middleware/response-time.middleware";
import { RequestLogMiddleware } from "app/infrastructure/bot/middleware/request-log.middleware";
import { RequestContextMiddleware } from "app/infrastructure/bot/middleware/request-context.middleware";
import { IsPrivateChatFilter } from "app/infrastructure/bot/filter/is-private-chat.filter";
import { HasSessionKeyFilter } from "app/infrastructure/bot/filter/has-session-key.filter";
import { FillUserToContextMiddleware } from "app/infrastructure/bot/middleware/fill-user-to-context.middleware";
import { StartCommand } from "app/infrastructure/bot/command/start/start.command";
import { StorageAdapter } from "grammy";
import { SessionPayload } from "app/infrastructure/bot/session/session.types";
import { PgsqlStorage } from "app/infrastructure/bot/session/pgsql-storage";
import { Database } from "app/infrastructure/database/database";
import { DatabaseSettings } from "app/infrastructure/database/database.types";
import { UserRepository } from "app/domain/user/user.repository";
import { PgSqlUserRepository } from "app/infrastructure/repository/pgsql-user-repository";
import { UserService } from "app/domain/user/user.service";
import { TelegramCallApiMiddleware } from "app/infrastructure/bot/middleware/mutation/telegram-call-api.middleware";
import { StartConversation } from "app/infrastructure/bot/conversation/start/start.conversation";

export class Container extends InversifyContainer {
    private alreadySetup = false;

    // Контекст собран до контейнера, поэтому всё, что связывается ниже, уже может
    // рассчитывать на его части. Дальше сам контекст нигде не фигурирует — потребители
    // берут части из контейнера по отдельности.
    public async setup(): Promise<void> {
        if (this.alreadySetup) {
            return;
        }

        const config = ApplicationContext.getConfigContainer();

        this.bind<ConfigContainer>(Tokens.Infrastructure.ConfigContainer).toConstantValue(config);
        this.bind<Logger>(Tokens.Infrastructure.Logger).toConstantValue(ApplicationContext.getLogger());
        this.bind<RequestContext>(Tokens.Infrastructure.RequestContext).toConstantValue(ApplicationContext.getRequestContext());
        this.bind<string>(Tokens.Infrastructure.RootDir).toConstantValue(config.rootDir);

        await this.setupModules(config);
        await this.setupServices(config);
        await this.setupInfrastructure(config);

        this.alreadySetup = true;
    }

    public async close(): Promise<void> {
        if (!this.alreadySetup) {
            return;
        }

        await this.get<Database>(Tokens.Infrastructure.Database).close();

        this.alreadySetup = false;
    }

    private async setupModules(config: ConfigContainer): Promise<void> {
        this.bind<Limit>(Tokens.TaskQueue.CommonLimit).toConstantValue(config.limits.common);
        this.bind<RunnerSettings>(Tokens.TaskQueue.RunnerSettings).toConstantValue(config.runner);

        this.bind<LimitResolver>(Tokens.TaskQueue.LimitResolver).to(TelegramLimitResolver).inSingletonScope();
        this.bind<TaskQueue>(Tokens.TaskQueue.TaskQueue).to(TaskQueue).inSingletonScope();
        this.bind<Runner>(Tokens.TaskQueue.Runner).to(Runner).inSingletonScope();

        await this.setupBot(config);
    }

    private async setupServices(config: ConfigContainer): Promise<void> {
        // font-convertor
        this.bind<FontConvertorSettings>(Tokens.Font.Convertor.Settings).toConstantValue({ tempDir: config.tempDir });
        this.bind<FontForgeSettings>(Tokens.Font.Engine.FontForgeSettings).toConstantValue({ executablePath: config.fontForgePath });

        this.bind<ConvertorFactory>(Tokens.Font.Convertor.Factory).to(ConvertorFactory).inSingletonScope();
        this.bind<FontForge>(Tokens.Font.Engine.FontForge).to(FontForge).inSingletonScope();
        this.bind<FontSignatureMatcher>(Tokens.Font.Signature.Matcher).to(FontSignatureMatcher).inSingletonScope();
        this.bind<EotPacker>(Tokens.Font.Envelope.Packer).to(EotPacker).inSingletonScope();
        this.bind<FontConvertor>(Tokens.Font.Convertor.Convertor).to(FontConvertor).inSingletonScope();

        // User
        this.bind<UserRepository>(Tokens.User.Repository).to(PgSqlUserRepository).inSingletonScope();
        this.bind<UserService>(Tokens.User.Service).to(UserService).inSingletonScope();
    }

    private async setupInfrastructure(config: ConfigContainer): Promise<void> {
        this.bind<DatabaseSettings>(Tokens.Infrastructure.DatabaseSettings).toConstantValue(config.database);
        this.bind<boolean>(Tokens.Infrastructure.IsProduction).toConstantValue(config.isProduction);

        this.bind<Database>(Tokens.Infrastructure.Database).to(Database).inSingletonScope();
    }

    private async setupBot(config: ConfigContainer): Promise<void> {
        this.bind<BotSettings>(Tokens.Bot.Settings).toConstantValue(config.bot);
        this.bind<TelegramLimits>(Tokens.Bot.Limits).toConstantValue(config.limits);

        this.bind<Bot>(Tokens.Bot.Bot).to(Bot).inSingletonScope();

        // Filters
        this.bind<HasSessionKeyFilter>(Tokens.Bot.Filter.HasSessionKey).to(HasSessionKeyFilter).inSingletonScope();
        this.bind<IsPrivateChatFilter>(Tokens.Bot.Filter.IsPrivateChat).to(IsPrivateChatFilter).inSingletonScope();

        // Middlewares
        this.bind<TelegramCallApiMiddleware>(Tokens.Bot.Middleware.Mutation.TelegramCallApi)
            .to(TelegramCallApiMiddleware)
            .inSingletonScope();

        this.bind<RequestContextMiddleware>(Tokens.Bot.Middleware.RequestContext).to(RequestContextMiddleware).inSingletonScope();
        this.bind<ResponseTimeMiddleware>(Tokens.Bot.Middleware.ResponseTime).to(ResponseTimeMiddleware).inSingletonScope();
        this.bind<RequestLogMiddleware>(Tokens.Bot.Middleware.RequestLog).to(RequestLogMiddleware).inSingletonScope();
        this.bind<FillUserToContextMiddleware>(Tokens.Bot.Middleware.FillUserToContext).to(FillUserToContextMiddleware).inSingletonScope();

        // Commands
        this.bind<StartCommand>(Tokens.Bot.Command.Start).to(StartCommand).inSingletonScope();
        this.bind<BulkMessagesCommand>(Tokens.Bot.Command.BulkMessages).to(BulkMessagesCommand).inSingletonScope();
        this.bind<FontGeneratorCommand>(Tokens.Bot.Command.FontGenerator).to(FontGeneratorCommand).inSingletonScope();

        // Session
        this.bind<StorageAdapter<SessionPayload>>(Tokens.Bot.Session.Storage).to(PgsqlStorage).inSingletonScope();

        // Conversations
        this.bind<StartConversation>(Tokens.Bot.Conversations.Start).to(StartConversation).inSingletonScope();
    }
}

export const container = new Container();
