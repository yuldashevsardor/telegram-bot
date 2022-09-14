import "reflect-metadata";
import { Container as InversifyContainer } from "inversify";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { Config } from "app/infrastructure/config/config";
import { FontForge } from "app/domain/font-convertor/font-forge/font-forge";
import { Services } from "app/infrastructure/container/symbols/services";
import { ConvertorFactory } from "app/domain/font-convertor/convertor/convertor-factory";
import { FontConvertor } from "app/domain/font-convertor/font-convertor";
import { Planner } from "app/domain/planner/planner";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { Broker } from "app/domain/broker/broker";
import { Bot } from "app/infrastructure/bot/bot";
import { BulkMessagesCommand } from "app/infrastructure/bot/command/bulk-messages.command";
import { FontGeneratorCommand } from "app/infrastructure/bot/command/font-generator.command";
import { ConsoleLogger } from "app/infrastructure/logger/console.logger";
import { Logger } from "app/domain/logger/logger";
import { ResponseTimeMiddleware } from "app/infrastructure/bot/middleware/response-time.middleware";
import { AbstractLogger } from "app/infrastructure/logger/abstract.logger";
import { RequestLogMiddleware } from "app/infrastructure/bot/middleware/request-log.middleware";
import { PinoLogger } from "app/infrastructure/logger/pino.logger";
import { asyncLocalStorage } from "app/infrastructure/async-local-storage";
import { AsyncLocalStorageMiddleware } from "app/infrastructure/bot/middleware/async-local-storage.middleware";
import { IsPrivateChatFilter } from "app/infrastructure/bot/filter/is-private-chat.filter";
import { FillUserToContextMiddleware } from "app/infrastructure/bot/middleware/fill-user-to-context.middleware";
import { StartCommand } from "app/infrastructure/bot/command/start.command";
import { StorageAdapter } from "grammy";
import { SessionPayload } from "app/infrastructure/bot/session/session.types";
import { PgsqlStorage } from "app/infrastructure/bot/session/pgsql.storage";
import { Database } from "app/infrastructure/database/database";
import { UserRepository } from "app/domain/user/user.repository";
import { PgSqlUserRepository } from "app/infrastructure/repository/pgsql.user.repository";
import { UserService } from "app/domain/user/user.service";
import { TelegramCallApiMiddleware } from "app/infrastructure/bot/middleware/mutation/telegram-call-api.middleware";
import { StartConversation } from "app/infrastructure/bot/conversation/start.conversation";

export class Container extends InversifyContainer {
    private alreadySetup = false;

    public async setup(): Promise<void> {
        if (this.alreadySetup) {
            return;
        }

        await this.setupModules();
        await this.setupServices();
        await this.setupInfrastructure();

        this.alreadySetup = true;
    }

    public async close(): Promise<void> {
        if (!this.alreadySetup) {
            return;
        }
    }

    private async setupModules(): Promise<void> {
        this.bind<Planner>(Modules.Planner.Planner).to(Planner).inSingletonScope();
        this.bind<Broker>(Modules.Broker.Broker).to(Broker).inSingletonScope();

        await this.setupBot();
    }

    private async setupServices(): Promise<void> {
        // font-convertor
        this.bind<ConvertorFactory>(Services.FontConvertor.ConvertorFactory).to(ConvertorFactory).inSingletonScope();
        this.bind<FontForge>(Services.FontConvertor.FontForge).to(FontForge).inSingletonScope();
        this.bind<FontConvertor>(Services.FontConvertor.FontConvertor).to(FontConvertor).inSingletonScope();

        // User
        this.bind<UserRepository>(Services.User.UserRepository).to(PgSqlUserRepository).inSingletonScope();
        this.bind<UserService>(Services.User.UserService).to(UserService).inSingletonScope();
    }

    private async setupInfrastructure(): Promise<void> {
        this.bind<Config>(Infrastructure.Config).to(Config).inSingletonScope();
        this.bind<Database>(Infrastructure.Database).to(Database).inSingletonScope();

        await this.setupInfrastructureLogger();
    }

    private async setupInfrastructureLogger(): Promise<void> {
        this.bind<ConsoleLogger>(Infrastructure.ConsoleLogger).to(ConsoleLogger).inSingletonScope();
        this.bind<PinoLogger>(Infrastructure.PinoLogger).to(PinoLogger).inSingletonScope();

        const config = this.get<Config>(Infrastructure.Config);
        const consoleLogger = this.get<ConsoleLogger>(Infrastructure.ConsoleLogger);
        const pinoLogger = this.get<PinoLogger>(Infrastructure.PinoLogger);

        consoleLogger.setLevels(config.logger.levels);
        pinoLogger.setLevels(config.logger.levels);

        this.rebind<Logger>(Infrastructure.ConsoleLogger).toConstantValue(consoleLogger);
        this.rebind<Logger>(Infrastructure.PinoLogger).toConstantValue(
            new Proxy(pinoLogger, {
                get(target, property, receiver): unknown {
                    target = asyncLocalStorage.getStore()?.get("logger") || target;
                    target.setLevels(config.logger.levels);

                    return Reflect.get(target, property, receiver);
                },
            }),
        );

        const defaultLogger = this.get<Logger>(config.logger.default);

        if (defaultLogger instanceof AbstractLogger) {
            defaultLogger.setLevels(config.logger.levels);
        }

        this.bind<Logger>(Infrastructure.Logger).toConstantValue(defaultLogger);
    }

    private async setupBot(): Promise<void> {
        this.bind<Bot>(Modules.Bot.Bot).to(Bot).inSingletonScope();

        // Filters
        this.bind<IsPrivateChatFilter>(Modules.Bot.Filter.IsPrivateChat).to(IsPrivateChatFilter).inSingletonScope();

        // Middlewares
        this.bind<TelegramCallApiMiddleware>(Modules.Bot.Middleware.Mutation.TelegramCallApi)
            .to(TelegramCallApiMiddleware)
            .inSingletonScope();

        this.bind<AsyncLocalStorageMiddleware>(Modules.Bot.Middleware.AsyncLocalStorage).to(AsyncLocalStorageMiddleware).inSingletonScope();
        this.bind<ResponseTimeMiddleware>(Modules.Bot.Middleware.ResponseTime).to(ResponseTimeMiddleware).inSingletonScope();
        this.bind<RequestLogMiddleware>(Modules.Bot.Middleware.RequestLog).to(RequestLogMiddleware).inSingletonScope();
        this.bind<FillUserToContextMiddleware>(Modules.Bot.Middleware.FillUserToContext).to(FillUserToContextMiddleware).inSingletonScope();

        // Commands
        this.bind<StartCommand>(Modules.Bot.Command.Start).to(StartCommand).inSingletonScope();
        this.bind<BulkMessagesCommand>(Modules.Bot.Command.BulkMessages).to(BulkMessagesCommand).inSingletonScope();
        this.bind<FontGeneratorCommand>(Modules.Bot.Command.FontGenerator).to(FontGeneratorCommand).inSingletonScope();

        // Session
        this.bind<StorageAdapter<SessionPayload>>(Modules.Bot.Session.Storage).to(PgsqlStorage).inSingletonScope();

        // Conversations
        this.bind<StartConversation>(Modules.Bot.Conversations.Start).to(StartConversation);
    }
}

export const container = new Container();
