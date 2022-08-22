import { NumberHelper } from "App/Infrastructure/Helpers/NumberHelper";

export class StringHelper {
    public static readonly LATIN_CHARACTERS_UPPER_CASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    public static readonly LATIN_CHARACTERS_LOWER_CASE = StringHelper.LATIN_CHARACTERS_UPPER_CASE.toLowerCase();

    public static readonly CYRILLIC_CHARACTERS_UPPER_CASE = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
    public static readonly CYRILLIC_CHARACTERS_LOWER_CASE = StringHelper.CYRILLIC_CHARACTERS_UPPER_CASE.toLowerCase();

    // noinspection NonAsciiCharacters
    public static readonly CYRILLIC_TO_LATIN = {
        а: "a",
        б: "b",
        в: "v",
        г: "g",
        д: "d",
        е: "e",
        ё: "yo",
        ж: "zh",
        з: "z",
        и: "i",
        й: "j",
        к: "k",
        л: "l",
        м: "m",
        н: "n",
        о: "o",
        п: "p",
        р: "r",
        с: "s",
        т: "t",
        у: "u",
        ф: "f",
        х: "kh",
        ц: "cz",
        ч: "ch",
        ш: "sh",
        щ: "shh",
        ъ: "``",
        ы: "y`",
        ь: "`",
        э: "e`",
        ю: "yu",
        я: "ya",
    };

    public static generateRandomStringByCharacters(length: number, characters: string): string {
        if (length < 1) {
            throw new Error("Random string length should be greater then 0");
        }

        const result: string[] = [];
        const charactersLength = characters.length;

        if (charactersLength < 1) {
            throw new Error("Character length for random string should be greater then 0");
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
