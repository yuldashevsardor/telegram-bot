/**
 * Confirms that a font is in one format: each validator checks only its own.
 */
export interface FontValidator {
    /**
     * Throws when the font at `fontPath` is not in the format of the validator.
     */
    validate(fontPath: string): Promise<void>;
}
