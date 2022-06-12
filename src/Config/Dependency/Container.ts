import "reflect-metadata";
import { Container as InversifyContainer } from "inversify";
import { Infrastructure } from "App/Config/Dependency/Symbols/Infrastructure";
import { Config } from "App/Config/Config";
import { FontForge } from "App/Services/FontConvertor/FontForge/FontForge";
import { Services } from "App/Config/Dependency/Symbols/Services";
import { ConvertorFactory } from "App/Services/FontConvertor/Convertor/ConvertorFactory";
import { FontConvertor } from "App/Services/FontConvertor/FontConvertor";
import { Planner } from "App/Modules/Planner/Planner";
import { Modules } from "App/Config/Dependency/Symbols/Modules";
import { Broker } from "App/Modules/Broker/Broker";
import { Bot } from "App/Modules/Bot/Bot";
import { StartCommand } from "App/Modules/Bot/Command/StartCommand";

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
    }

    private async loadBot(): Promise<void> {
        this.bind<Bot>(Modules.Bot.Bot).to(Bot).inSingletonScope();

        // Commands
        this.bind<StartCommand>(Modules.Bot.Command.Start).to(StartCommand).inSingletonScope();
    }
}

export const container = new Container();
