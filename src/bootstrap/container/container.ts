import "reflect-metadata";
import { Container as InversifyContainer, interfaces } from "inversify";
import { Tokens } from "app/shared/tokens";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ConfigContainer } from "app/bootstrap/config-container";
import { RequestContext } from "app/platform/request-context/request-context";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/font-signature-matcher";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { FontConvertor } from "app/font-convertor/font-convertor";
import { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { Runner } from "app/telegram/outbound-queue/runner";
import { LimitResolver } from "app/telegram/outbound-queue/limit-resolver";
import { TelegramLimitResolver } from "app/telegram/telegram-limit-resolver";
import { Bot } from "app/telegram/bot";
import { BotHandlers } from "app/telegram/bot.types";
import { Filter } from "app/telegram/filter/filter";
import { Middleware } from "app/telegram/middleware/middleware";
import { ConversationHandler } from "app/telegram/conversation/conversation-handler";
import { Command } from "app/telegram/command/command";
import { BulkMessagesCommand } from "app/telegram/command/bulk-messages/bulk-messages.command";
import { FontGeneratorCommand } from "app/telegram/command/font-generator/font-generator.command";
import { Logger } from "app/platform/logger/logger";
import { ResponseTimeMiddleware } from "app/telegram/middleware/response-time.middleware";
import { RequestLogMiddleware } from "app/telegram/middleware/request-log.middleware";
import { RequestContextMiddleware } from "app/telegram/middleware/request-context.middleware";
import { IsPrivateChatFilter } from "app/telegram/filter/is-private-chat.filter";
import { HasSessionKeyFilter } from "app/telegram/filter/has-session-key.filter";
import { FillUserToContextMiddleware } from "app/telegram/middleware/fill-user-to-context.middleware";
import { StartCommand } from "app/telegram/command/start/start.command";
import { StorageAdapter } from "grammy";
import { SessionPayload } from "app/telegram/session/session.types";
import { PgsqlStorage } from "app/telegram/session/pgsql-storage";
import { Database } from "app/platform/database/database";
import { UserRepository } from "app/telegram/user/user.repository";
import { PgSqlUserRepository } from "app/telegram/user/pgsql-user-repository";
import { UserService } from "app/telegram/user/user.service";
import { TelegramCallApiMiddleware } from "app/telegram/middleware/mutation/telegram-call-api.middleware";
import { StartConversation } from "app/telegram/conversation/start/start.conversation";

export class Container extends InversifyContainer {
    private alreadySetup = false;

    // Контекст собран до контейнера, поэтому всё, что связывается ниже, уже может
    // рассчитывать на его части. Дальше сам контекст нигде не фигурирует — потребители
    // берут части из контейнера по отдельности.
    public async setup(): Promise<void> {
        if (this.alreadySetup) {
            return;
        }

        await this.setupBootstrap();
        await this.setupFontConvertor();
        await this.setupTelegram();
        await this.setupPlatform();

        this.alreadySetup = true;
    }

    public async close(): Promise<void> {
        if (!this.alreadySetup) {
            return;
        }

        await this.get<Database>(Tokens.Platform.Database).close();

        this.alreadySetup = false;
    }

    private async setupBootstrap(): Promise<void> {
        this.bind<ConfigContainer>(Tokens.Bootstrap.ConfigContainer).toConstantValue(ApplicationContext.getConfigContainer());
        this.bind<Logger>(Tokens.Bootstrap.Logger).toConstantValue(ApplicationContext.getLogger());
        this.bind<RequestContext>(Tokens.Bootstrap.RequestContext).toConstantValue(ApplicationContext.getRequestContext());
    }

    private async setupFontConvertor(): Promise<void> {
        this.bind<ConvertorFactory>(Tokens.Font.Convertor.Factory).to(ConvertorFactory).inSingletonScope();
        this.bind<FontForge>(Tokens.Font.Engine.FontForge).to(FontForge).inSingletonScope();
        this.bind<FontSignatureMatcher>(Tokens.Font.Signature.Matcher).to(FontSignatureMatcher).inSingletonScope();
        this.bind<EotPacker>(Tokens.Font.Envelope.Packer).to(EotPacker).inSingletonScope();
        this.bind<FontConvertor>(Tokens.Font.Convertor.Convertor).to(FontConvertor).inSingletonScope();
    }

    private async setupTelegram(): Promise<void> {
        this.bind<Bot>(Tokens.Bot.Bot).to(Bot).inSingletonScope();

        // Outbound queue
        this.bind<LimitResolver>(Tokens.Bot.OutboundQueue.LimitResolver).to(TelegramLimitResolver).inSingletonScope();
        this.bind<TaskQueue>(Tokens.Bot.OutboundQueue.TaskQueue).to(TaskQueue).inSingletonScope();
        this.bind<Runner>(Tokens.Bot.OutboundQueue.Runner).to(Runner).inSingletonScope();

        // User
        this.bind<UserRepository>(Tokens.Bot.User.Repository).to(PgSqlUserRepository).inSingletonScope();
        this.bind<UserService>(Tokens.Bot.User.Service).to(UserService).inSingletonScope();

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

        // Обработчики резолвятся вместе с Bot, поэтому символ без биндинга валит резолв Bot,
        // а не всплывает позже внутри Bot.setup().
        this.bind<BotHandlers>(Tokens.Bot.Handlers).toDynamicValue(this.resolveBotHandlers).inSingletonScope();
    }

    // Порядок в списках — порядок пайплайна (docs/architecture/bot.md), Bot.setup() его не
    // меняет.
    private resolveBotHandlers({ container }: interfaces.Context): BotHandlers {
        return {
            // IsPrivateChat отбрасывает молча и без chat тоже, поэтому апдейты без ключа
            // сессии должен раньше увидеть HasSessionKey с его warning.
            filters: [container.get<Filter>(Tokens.Bot.Filter.HasSessionKey), container.get<Filter>(Tokens.Bot.Filter.IsPrivateChat)],
            middlewares: [
                container.get<Middleware>(Tokens.Bot.Middleware.RequestContext),
                container.get<Middleware>(Tokens.Bot.Middleware.Mutation.TelegramCallApi),
                container.get<Middleware>(Tokens.Bot.Middleware.ResponseTime),
                container.get<Middleware>(Tokens.Bot.Middleware.RequestLog),
                container.get<Middleware>(Tokens.Bot.Middleware.FillUserToContext),
            ],
            conversations: Object.values(Tokens.Bot.Conversations).map((symbol) => container.get<ConversationHandler>(symbol)),
            commands: Object.values(Tokens.Bot.Command).map((symbol) => container.get<Command>(symbol)),
        };
    }

    private async setupPlatform(): Promise<void> {
        this.bind<Database>(Tokens.Platform.Database).to(Database).inSingletonScope();
    }
}

export const container = new Container();
