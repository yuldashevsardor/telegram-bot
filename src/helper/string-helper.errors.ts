import { RuntimeError } from "app/common/errors";

export class InvalidRandomStringParams extends RuntimeError {
    public static byLength(length: number): InvalidRandomStringParams {
        return new InvalidRandomStringParams("Random string length should be greater then 0", {
            length: length,
        });
    }

    public static emptyCharacters(): InvalidRandomStringParams {
        return new InvalidRandomStringParams("Character length for random string should be greater then 0");
    }
}
