/**
 * The sfnt container versions the domain accepts. Each carries exactly one font: TrueType
 * outlines (0x00010000), their old Macintosh variant ("true") and CFF ("OTTO"). The collection
 * ("ttcf") is not here: it holds several fonts, and which one to take is not the domain's call
 * (issue https://github.com/yuldashevsardor/telegram-bot/issues/181).
 *
 * One set serves four checks. `SfntFontValidator` checks the version of a source under an sfnt
 * extension and of the sfnt a WOFF or an EOT carries against it. `SfntTableDirectory` checks the
 * version before parsing the table directory, and files that never passed the validator reach it
 * too. `WoffFontValidator` and `Woff2FontValidator` check the flavor of a WOFF and a WOFF2 against
 * it: the flavor is the version of the enclosed sfnt. The set must not become several lists: a
 * divergence breaks behaviour, not the build (docs/architecture/font-convertor.md, "Signatures").
 */
export const SFNT_VERSIONS: ReadonlyArray<number> = [0x00010000, 0x74727565, 0x4f54544f];
