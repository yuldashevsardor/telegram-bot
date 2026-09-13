import "reflect-metadata";
import { expect } from "chai";
import { Container } from "app/bootstrap/container/container";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ConfigContainer } from "app/bootstrap/config-container";
import type { ConfigStorage } from "app/platform/config/config-storage";
import type { Logger } from "app/platform/logger/logger";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { RequestContext } from "app/platform/request-context/request-context";
import { Tokens } from "app/shared/tokens";

type Branch = { [key: string]: symbol | Branch };

type ContextParts = {
    config: ConfigContainer | null;
    logger: Logger | null;
    requestContext: RequestContext | null;
};

class FakeStorage implements ConfigStorage {
    public constructor(private readonly values: Record<string, string>) {}

    public get(key: string): string | undefined {
        return this.values[key];
    }
}

function collectTokens(branch: Branch, path: string[] = []): Array<{ path: string[]; token: symbol }> {
    return Object.entries(branch).flatMap(([key, value]) =>
        typeof value === "symbol" ? [{ path: [...path, key], token: value }] : collectTokens(value, [...path, key]),
    );
}

// ApplicationContext.create() собирает конфиг из реального окружения, а пустой BOT_TOKEN
// валит конструктор Bot. Поэтому части кладутся в статические поля мимо create(): шов для
// тестов менял бы публичную форму контекста. Поля обнуляются в after — контекст общий на весь
// прогон mocha, и заполненным он молча отдал бы этот конфиг configValue() в чужих спеках.
const context = ApplicationContext as unknown as ContextParts;

describe("Container", () => {
    const container = new Container();

    before(async () => {
        const requestContext = new RequestContext();

        context.config = new ConfigContainer(new FakeStorage({ BOT_TOKEN: "test-token" }));
        context.requestContext = requestContext;
        context.logger = new ConsoleLogger(requestContext);

        await container.setup();
    });

    after(async () => {
        await container.close();

        context.config = null;
        context.requestContext = null;
        context.logger = null;
    });

    // Резолв без внешних ресурсов: postgres() не подключается до первого запроса, а grammY
    // не ходит в сеть до init(). Ловит забытый биндинг, второй биндинг под тем же символом
    // («Ambiguous match») и пропущенный @inject не в хвосте конструктора; забытый @inject у
    // последнего параметра резолв не валит (docs/architecture/invariants.md).
    for (const { path, token } of collectTokens(Tokens)) {
        it(`resolves Tokens.${path.join(".")}`, () => {
            expect(container.get(token)).to.not.equal(undefined);
        });
    }
});
