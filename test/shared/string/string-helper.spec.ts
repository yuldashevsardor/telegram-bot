import { expect } from "chai";
import { StringHelper } from "app/shared/string/string-helper";
import { InvalidRandomStringParams } from "app/shared/string/string-helper.errors";

describe("StringHelper.generateRandomStringByCharacters", function () {
    it("builds a string of the requested length from the given characters only", function () {
        expect(StringHelper.generateRandomStringByCharacters(50, "ab")).to.match(/^[ab]{50}$/);
    });

    it("refuses a length below one", function () {
        expect(() => StringHelper.generateRandomStringByCharacters(0, "ab"))
            .to.throw(InvalidRandomStringParams)
            .with.property("payload")
            .that.deep.equals({ length: 0 });
    });

    it("refuses an empty set of characters", function () {
        expect(() => StringHelper.generateRandomStringByCharacters(5, "")).to.throw(InvalidRandomStringParams, "Character length");
    });
});

describe("StringHelper.generateRandomString", function () {
    it("builds a string of latin letters and digits", function () {
        expect(StringHelper.generateRandomString(15)).to.match(/^[A-Za-z0-9]{15}$/);
    });
});
