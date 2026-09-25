/**
 * The sfnt container versions the domain accepts. Each carries exactly one font: TrueType
 * outlines (0x00010000), their old Macintosh variant ("true") and CFF ("OTTO"). The collection
 * ("ttcf") is not here: it holds several fonts, and which one to take is not the domain's call
 * (issue https://github.com/yuldashevsardor/telegram-bot/issues/181).
 *
 * One set serves two checks. `FontSignatureMatcher` matches the first four bytes of a source
 * under an sfnt extension against it. `SfntReader` checks the version before parsing the table
 * directory, and files that never passed the signature reach it too. The set must not become two
 * lists: a divergence breaks behaviour, not the build (docs/architecture/font-convertor.md,
 * "Signatures").
 */
export const SFNT_VERSIONS: ReadonlyArray<number> = [0x00010000, 0x74727565, 0x4f54544f];

/**
 * The version as the four bytes of the file head: the container stores it big-endian.
 */
export function sfntVersionBytes(version: number): Array<number> {
    return [24, 16, 8, 0].map((shift) => (version >>> shift) & 0xff);
}
