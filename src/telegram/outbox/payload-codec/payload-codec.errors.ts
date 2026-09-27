import { RuntimeError } from "app/shared/errors";

export class UnsupportedInputFile extends RuntimeError {
    public static inMethod(method: string): UnsupportedInputFile {
        return new UnsupportedInputFile(`${method} got an InputFile not made by queueFile(): the outbox stores a file only by its path.`, {
            method: method,
        });
    }
}
