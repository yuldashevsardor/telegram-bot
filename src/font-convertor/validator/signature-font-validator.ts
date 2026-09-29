import { InvalidFontSignature } from "app/font-convertor/font-convertor.errors";
import type { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import type { SignedExtension } from "app/font-convertor/signature-matcher/font-signature-matcher.types";
import type { FontValidator } from "app/font-convertor/validator/font-validator";
import { FileHelper } from "app/shared/fs/file-helper";

/**
 * Checks a format that has a signature: the first `headLength` bytes of the font.
 */
export class SignatureFontValidator implements FontValidator {
    public constructor(private readonly fontSignatureMatcher: FontSignatureMatcher, private readonly extension: SignedExtension) {}

    public async validate(fontPath: string): Promise<void> {
        const head = await FileHelper.readHead(fontPath, this.fontSignatureMatcher.headLength);

        if (!this.fontSignatureMatcher.matches(head, this.extension)) {
            throw InvalidFontSignature.byPathAndExtension(fontPath, this.extension);
        }
    }
}
