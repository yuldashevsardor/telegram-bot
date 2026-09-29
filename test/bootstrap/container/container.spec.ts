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

    // A resolve with no external resources: postgres() does not connect before the first query, and
    // grammY does not go to the network before init(). What it catches and what it does not —
    // docs/architecture/application.md, "DI".
    for (const { path, token } of collectTokens(Tokens)) {
        it(`resolves Tokens.${path.join(".")}`, () => {
            expect(container.get(token)).to.not.equal(undefined);
        });
    }

    it("keeps one binding per token when set up again", async () => {
        await container.setup();

        expect(container.getAll(Tokens.Platform.Database)).to.have.lengthOf(1);
    });

    // A closed postgres pool refuses a query at once, without going to the network (handler() in the
    // index.js of the package).
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

    // There is no assertion, the check is the failure itself: without the early return close() would
    // resolve Database from an empty container and fail with "No matching bindings found".
    it("does nothing when closed before setup", async () => {
        await new Container().close();
    });
});
