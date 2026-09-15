import { NumberHelper } from "app/shared/number-helper";
import { InvalidRandomStringParams } from "app/shared/string/string-helper.errors";

export class StringHelper {
    public static readonly LATIN_CHARACTERS_UPPER_CASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    public static readonly LATIN_CHARACTERS_LOWER_CASE = StringHelper.LATIN_CHARACTERS_UPPER_CASE.toLowerCase();

    public static generateRandomStringByCharacters(length: number, characters: string): string {
        if (length < 1) {
            throw InvalidRandomStringParams.byLength(length);
        }

        const result: string[] = [];
        const charactersLength = characters.length;

        if (charactersLength < 1) {
            throw InvalidRandomStringParams.emptyCharacters();
        }

        for (let i = 0; i < length; i++) {
            result.push(characters.charAt(Math.floor(Math.random() * charactersLength)));
        }

        return result.join("");
    }

    public static generateRandomString(length: number): string {
        return StringHelper.generateRandomStringByCharacters(
            length,
            StringHelper.LATIN_CHARACTERS_UPPER_CASE + StringHelper.LATIN_CHARACTERS_LOWER_CASE + NumberHelper.NUMBERS,
        );
    }
}
