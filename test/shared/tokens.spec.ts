import { expect } from "chai";
import { Tokens } from "app/shared/tokens";

type Branch = { [key: string]: symbol | Branch };

function collectTokens(branch: Branch, path: string[] = []): Array<{ path: string[]; token: symbol }> {
    return Object.entries(branch).flatMap(([key, value]) =>
        typeof value === "symbol" ? [{ path: [...path, key], token: value }] : collectTokens(value, [...path, key]),
    );
}

describe("Tokens", () => {
    it("keys every symbol by its path in the dictionary", () => {
        for (const { path, token } of collectTokens(Tokens)) {
            expect(Symbol.keyFor(token), path.join(".")).to.equal(path.join(""));
        }
    });

    // Сверка выше пропускает склейку, совпавшую у двух разных путей (пример — в шапке
    // shared/tokens.ts): оба символа ключены своим путём, но это один символ.
    it("gives every symbol its own string", () => {
        const keys = collectTokens(Tokens).map(({ token }) => Symbol.keyFor(token));

        expect(keys.filter((key, index) => keys.indexOf(key) !== index)).to.deep.equal([]);
    });
});
