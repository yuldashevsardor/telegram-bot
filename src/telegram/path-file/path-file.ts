import { isAbsolute } from "node:path";
import { InputFile } from "grammy";
import { RelativeFilePath } from "app/telegram/path-file/path-file.errors";

/**
 * A file to send, given by its absolute path, in place of `new InputFile(path)`. A call that goes
 * through the outbox is stored in the database and may be sent by another node, so its file travels
 * as its path, and the sending node reads it from there. grammY keeps the source of an InputFile
 * private, so only this class can tell the outbox codec the path; the codec accepts no other
 * InputFile.
 */
export class PathFile extends InputFile {
    public readonly path: string;

    public constructor(path: string, filename?: string) {
        // The sending node would resolve a relative path against its own working directory, not
        // against the one of the node that queued the call.
        if (!isAbsolute(path)) {
            throw RelativeFilePath.byPath(path);
        }

        super(path, filename);

        this.path = path;
    }
}
