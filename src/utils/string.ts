import { LATIN_CHARACTERS_LOWER_CASE, LATIN_CHARACTERS_UPPER_CASE, NUMBERS } from "./constants";

export function generateRandomStringByCharacters(length: number, characters: string): string {
    if (length < 1) {
        throw new Error("Random string length should be greater then 0");
    }

    const result = [];
    const charactersLength = characters.length;

    if (charactersLength < 1) {
        throw new Error("Character length for random string should be greater then 0");
    }

    for (let i = 0; i < length; i++) {
        result.push(characters.charAt(Math.floor(Math.random() * charactersLength)));
    }

    return result.join("");
}

export function generateRandomString(length: number): string {
    return generateRandomStringByCharacters(length, LATIN_CHARACTERS_UPPER_CASE + LATIN_CHARACTERS_LOWER_CASE + NUMBERS);
}
