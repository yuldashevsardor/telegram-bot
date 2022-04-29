export const LATIN_CHARACTERS_UPPER_CASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const LATIN_CHARACTERS_LOWER_CASE = LATIN_CHARACTERS_UPPER_CASE.toLowerCase();

export const CYRILLIC_CHARACTERS_UPPER_CASE = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
export const CYRILLIC_CHARACTERS_LOWER_CASE = CYRILLIC_CHARACTERS_UPPER_CASE.toLowerCase();

// noinspection NonAsciiCharacters
export const CYRILLIC_TO_LATIN = {
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

export const NUMBERS = "0123456789";

export function sleep(time: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve();
        }, time);
    });
}

export function generateNumber(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

export function generateString(length: number): string {
    const result = [];
    const characters = LATIN_CHARACTERS_UPPER_CASE + LATIN_CHARACTERS_LOWER_CASE + NUMBERS;
    const charactersLength = characters.length;

    for (let i = 0; i < length; i++) {
        result.push(characters.charAt(Math.floor(Math.random() * charactersLength)));
    }

    return result.join("");
}

// export
