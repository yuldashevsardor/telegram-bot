import { RuntimeError } from "app/shared/errors";

export class UnsupportedInputFile extends RuntimeError {
    public static inMethod(method: string): UnsupportedInputFile {
        return new UnsupportedInputFile(`${method} got an InputFile that is not a QueuedFile: the outbox stores a file only by its path.`, {
            method: method,
        });
    }
}

export class InvalidFileMarker extends RuntimeError {
    public static byMarker(marker: unknown): InvalidFileMarker {
        return new InvalidFileMarker(
            "Stored payload has a file marker whose path is not a string or whose file name is neither a string nor absent.",
            {
                marker: marker,
            },
        );
    }
}

export class ReservedFileKey extends RuntimeError {
    public static inMethod(method: string): ReservedFileKey {
        return new ReservedFileKey(`${method} got an object with the key $queuedFile, which the outbox keeps for a file marker.`, {
            method: method,
        });
    }
}
