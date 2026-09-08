import { RuntimeError } from "app/common/errors";

export class InvalidSfnt extends RuntimeError {
    public static tooShort(length: number): InvalidSfnt {
        return new InvalidSfnt(`Sfnt font is too short: ${length} bytes.`, {
            length: length,
        });
    }

    public static unknownVersion(version: number): InvalidSfnt {
        return new InvalidSfnt(`Unknown sfnt version: 0x${version.toString(16).padStart(8, "0")}.`, {
            version: version,
        });
    }

    public static truncatedTable(tag: string): InvalidSfnt {
        return new InvalidSfnt(`Sfnt table ${tag} does not fit into the font.`, {
            tag: tag,
        });
    }

    public static tableNotFound(tag: string): InvalidSfnt {
        return new InvalidSfnt(`Sfnt table ${tag} not found.`, {
            tag: tag,
        });
    }

    public static nameNotFound(nameId: number): InvalidSfnt {
        return new InvalidSfnt(`Sfnt name record ${nameId} not found.`, {
            nameId: nameId,
        });
    }
}
