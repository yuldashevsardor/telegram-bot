import { RuntimeError } from "app/shared/errors";

export class RelativeFilePath extends RuntimeError {
    public static byPath(path: string): RelativeFilePath {
        return new RelativeFilePath("PathFile got a relative path: every node that may send the file must read it at the same place.", {
            path: path,
        });
    }
}
