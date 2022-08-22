import "reflect-metadata";
import { Container as InversifyContainer } from "inversify";
import { Infrastructure } from "App/Infrastructure/Config/Dependency/Symbols/Infrastructure";
import { Config } from "App/Infrastructure/Config/Config";
import { FontForge } from "App/Domain/FontConvertor/FontForge/FontForge";
import { Services } from "App/Infrastructure/Config/Dependency/Symbols/Services";
import { ConvertorFactory } from "App/Domain/FontConvertor/Convertor/ConvertorFactory";
import { FontConvertor } from "App/Domain/FontConvertor/FontConvertor";
import { Planner } from "App/Domain/Planner/Planner";
import { Modules } from "App/Infrastructure/Config/Dependency/Symbols/Modules";
import { Broker } from "App/Domain/Broker/Broker";
import { Bot } from "App/Infrastructure/Bot/Bot";
import { BulkMessagesCommand } from "App/Infrastructure/Bot/Command/BulkMessagesCommand";
import { FontGeneratorCommand } from "App/Infrastructure/Bot/Command/FontGeneratorCommand";
import { ConsoleLogger } from "App/Infrastructure/Logger/ConsoleLogger";
import { Logger } from "App/Domain/Logger/Logger";
import { ResponseTimeMiddleware } from "App/Infrastructure/Bot/Middleware/ResponseTimeMiddleware";
import { AbstractLogger } from "App/Infrastructure/Logger/AbstractLogger";
import { RequestLogMiddleware } from "App/Infrastructure/Bot/Middleware/RequestLogMiddleware";
import { PinoLogger } from "App/Infrastructure/Logger/PinoLogger";
import { asyncLocalStorage } from "App/Infrastructure/Config/AsyncLocalStorage";
import { AsyncLocalStorageMiddleware } from "App/Infrastructure/Bot/Middleware/AsyncLocalStorageMiddleware";
import { OnlyPrivateChatMiddleware } from "App/Infrastructure/Bot/Middleware/OnlyPrivateChatMiddleware";
import { FillUserToContextMiddleware } from "App/Infrastructure/Bot/Middleware/FillUserToContextMiddleware";

class Container extends InversifyContainer {
    private isLoaded = false;

    public async load(): Promise<void> {
        if (this.isLoaded) {
            return;
        }

        await this.loadModules();
        await this.loadServices();
        await this.loadInfrastructure();

        this.isLoaded = true;
    }

    public async close(): Promise<void> {
        if (!this.isLoaded) {
            return;
        }
    }

    private async loadModules(): Promise<void> {
        this.bind<Planner>(Modules.Planner.Planner).to(Planner).inSingletonScope();
        this.bind<Broker>(Modules.Broker.Broker).to(Broker).inSingletonScope();

        await this.loadBot();
    }

    private async loadServices(): Promise<void> {
        // FontConvertor
        this.bind<ConvertorFactory>(Services.FontConvertor.ConvertorFactory).to(ConvertorFactory).inSingletonScope();
        this.bind<FontForge>(Services.FontConvertor.FontForge).to(FontForge).inSingletonScope();
        this.bind<FontConvertor>(Services.FontConvertor.FontConvertor).to(FontConvertor).inSingletonScope();
    }

    private async loadInfrastructure(): Promise<void> {
        this.bind<Config>(Infrastructure.Config).to(Config).inSingletonScope();

        await this.loadInfrastructureLogger();
    }

    private async loadInfrastructureLogger(): Promise<void> {
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

    private async loadBot(): Promise<void> {
        this.bind<Bot>(Modules.Bot.Bot).to(Bot).inSingletonScope();

        // Middlewares
        this.bind<AsyncLocalStorageMiddleware>(Modules.Bot.Middleware.AsyncLocalStorage).to(AsyncLocalStorageMiddleware).inSingletonScope();
        this.bind<ResponseTimeMiddleware>(Modules.Bot.Middleware.ResponseTime).to(ResponseTimeMiddleware).inSingletonScope();
        this.bind<RequestLogMiddleware>(Modules.Bot.Middleware.RequestLog).to(RequestLogMiddleware).inSingletonScope();
        this.bind<OnlyPrivateChatMiddleware>(Modules.Bot.Middleware.OnlyPrivateChat).to(OnlyPrivateChatMiddleware).inSingletonScope();
        this.bind<FillUserToContextMiddleware>(Modules.Bot.Middleware.FillUserToContext).to(FillUserToContextMiddleware).inSingletonScope();

        // Commands
        this.bind<BulkMessagesCommand>(Modules.Bot.Command.BulkMessages).to(BulkMessagesCommand).inSingletonScope();
        this.bind<FontGeneratorCommand>(Modules.Bot.Command.FontGenerator).to(FontGeneratorCommand).inSingletonScope();
    }
}

export const container = new Container();
