export class NumberHelper {
    public static readonly NUMBERS = "0123456789";

    public static generateNumber(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1) + min);
    }

    /**
     * `value` rounded up to a multiple of `multiple`. Not with a bit mask: the operands of JavaScript
     * bitwise operators are 32-bit signed, and a value read from a file may be up to 2^32 − 1.
     */
    public static roundUp(value: number, multiple: number): number {
        return Math.ceil(value / multiple) * multiple;
    }
}
