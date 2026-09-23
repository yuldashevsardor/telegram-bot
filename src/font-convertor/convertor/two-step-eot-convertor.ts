import { Convertor } from "app/font-convertor/convertor/convertor";
import type { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FileHelper } from "app/shared/fs/file-helper";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import type { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";

/**
 * An EOT pair that needs both: the codec takes the envelope off or puts it on, the engine moves
 * the outlines. Between them an intermediate sfnt stays on disk.
 */
export abstract class TwoStepEotConvertor extends Convertor {
    public constructor(
        protected readonly fontForge: FontForge,
        fontSignatureMatcher: FontSignatureMatcher,
        protected readonly eotPacker: EotPacker,
    ) {
        super(fontSignatureMatcher);
    }

    /**
     * The path of the intermediate sfnt: the result name is unique in its directory, so a name
     * derived from it is unique too.
     */
    protected intermediatePath(newPath: string): string {
        return `${newPath}.${Extension.TTF}`;
    }

    /**
     * Runs both steps and removes the intermediate file — after a success and after a failure
     * alike. The removal does not go through `finally`: there its own error would displace the
     * original one, and the real reason for the failure would not survive even in `cause`.
     */
    protected async throughIntermediate(sfntPath: string, steps: () => Promise<void>): Promise<void> {
        let failure: unknown;

        try {
            await steps();
        } catch (error) {
            failure = error;
        }

        try {
            await FileHelper.remove(sfntPath);
        } catch (error) {
            failure ??= error;
        }

        if (failure !== undefined) {
            throw failure;
        }
    }
}
