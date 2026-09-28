import { Convertor } from "app/font-convertor/convertor/convertor";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import type { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";

export abstract class FontForgeConvertor extends Convertor {
    public constructor(protected readonly fontForge: FontForge, fontValidatorResolver: FontValidatorResolver) {
        super(fontValidatorResolver);
    }
}
