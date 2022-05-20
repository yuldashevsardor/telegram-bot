export class NumberHelper {
    public static readonly NUMBERS = "0123456789";

    public static generateNumber(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1) + min);
    }
}
