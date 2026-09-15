import "reflect-metadata";
import { expect } from "chai";
import { Container } from "app/bootstrap/container/container";
import type { Database } from "app/platform/database/database";
import { Tokens } from "app/shared/tokens";
import { fillApplicationContext, resetApplicationContext } from "test/bootstrap/application/application-context.helper";

type Branch = { [key: string]: symbol | Branch };

function collectTokens(branch: Branch, path: string[] = []): Array<{ path: string[]; token: symbol }> {
    return Object.entries(branch).flatMap(([key, value]) =>
        typeof value === "symbol" ? [{ path: [...path, key], token: value }] : collectTokens(value, [...path, key]),
    );
}

describe("Container", () => {
    const container = new Container();

    before(async () => {
        await fillApplicationContext();
        await container.setup();
    });

    after(async () => {
        try {
            await container.close();
        } finally {
            resetApplicationContext();
        }
    });

    // Резолв без внешних ресурсов: postgres() не подключается до первого запроса, а grammY
    // не ходит в сеть до init(). Что он ловит и чего нет — docs/architecture/application.md, «DI».
    for (const { path, token } of collectTokens(Tokens)) {
        it(`resolves Tokens.${path.join(".")}`, () => {
            expect(container.get(token)).to.not.equal(undefined);
        });
    }

    it("keeps one binding per token when set up again", async () => {
        await container.setup();

        expect(container.getAll(Tokens.Platform.Database)).to.have.lengthOf(1);
    });

    // Закрытый пул postgres отвергает запрос сразу, не выходя в сеть (handler() в index.js пакета).
    it("closes the database pool", async () => {
        const closable = new Container();
        await closable.setup();

        await closable.close();

        const error = await closable
            .get<Database>(Tokens.Platform.Database)
            .check()
            .then(
                () => expect.fail("the query was expected to be refused"),
                (reason: unknown) => reason,
            );

        expect(error).to.have.property("code", "CONNECTION_ENDED");
    });

    // Утверждения нет, проверка — сам отказ: без раннего выхода close() резолвил бы Database
    // из пустого контейнера и падал «No matching bindings found».
    it("does nothing when closed before setup", async () => {
        await new Container().close();
    });
});
