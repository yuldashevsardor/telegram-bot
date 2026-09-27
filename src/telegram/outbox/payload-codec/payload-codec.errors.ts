import { RuntimeError } from "app/shared/errors";

export class UnsupportedInputFile extends RuntimeError {
    public static inMethod(method: string): UnsupportedInputFile {
        return new UnsupportedInputFile(`${method} got an InputFile not made by queueFile(): the outbox stores a file only by its path.`, {
            method: method,
        });
    }
}

export class InvalidFileMarker extends RuntimeError {
    public static byMarker(marker: unknown): InvalidFileMarker {
        return new InvalidFileMarker("Stored payload has a file marker without a string path and an optional string file name.", {
            marker: marker,
        });
    }
}
