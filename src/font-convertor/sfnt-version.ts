/**
 * The sfnt container versions the domain accepts. Each carries exactly one font: TrueType
 * outlines (0x00010000), their old Macintosh variant ("true") and CFF ("OTTO"). The collection
 * ("ttcf") is not here: it holds several fonts, and which one to take is not the domain's call
 * (issue https://github.com/yuldashevsardor/telegram-bot/issues/181).
 *
 * One set serves four checks: `SfntFontValidator`, `SfntTableDirectory`, and the flavor checks of
 * `WoffFontValidator` and `Woff2FontValidator`. It must not become several lists: a divergence
 * breaks behaviour, not the build (docs/architecture/font-convertor.md, "Signatures").
 */
export const SFNT_VERSIONS: ReadonlyArray<number> = [0x00010000, 0x74727565, 0x4f54544f];
