import { expect } from "chai";
import { StringHelper } from "app/shared/string/string-helper";
import { InvalidRandomStringParams } from "app/shared/string/string-helper.errors";

describe("StringHelper.generateRandomStringByCharacters", function () {
    it("builds a string of the requested length from the given characters only", function () {
        expect(StringHelper.generateRandomStringByCharacters(50, "ab")).to.match(/^[ab]{50}$/);
    });

    it("accepts a length of one and a single character", function () {
        expect(StringHelper.generateRandomStringByCharacters(1, "a")).to.equal("a");
    });

    it("refuses a length below one", function () {
        expect(() => StringHelper.generateRandomStringByCharacters(0, "ab"))
            .to.throw(InvalidRandomStringParams, "Random string length should be greater than 0")
            .with.property("payload")
            .that.deep.equals({ length: 0 });
    });

    it("refuses an empty set of characters", function () {
        expect(() => StringHelper.generateRandomStringByCharacters(5, "")).to.throw(InvalidRandomStringParams, "Character length");
    });
});

describe("StringHelper.generateRandomString", function () {
    const random = Math.random;

    afterEach(function () {
        Math.random = random;
    });

    it("builds a string of latin letters and digits", function () {
        expect(StringHelper.generateRandomString(15)).to.match(/^[A-Za-z0-9]{15}$/);
    });

    // Проверка выше пропустит и урезанный алфавит: строка из одних цифр ей тоже подходит.
    // Здесь каждый вызов Math.random попадает в середину очередного символа алфавита, и
    // строка в 62 символа перебирает его целиком.
    it("draws on every latin letter in both cases and every digit", function () {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let draw = 0;
        Math.random = (): number => (draw++ + 0.5) / alphabet.length;

        expect([...StringHelper.generateRandomString(alphabet.length)]).to.have.members([...alphabet]);
    });
});
