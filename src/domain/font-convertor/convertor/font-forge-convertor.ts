import { Convertor } from "app/domain/font-convertor/convertor/convertor";
import { FontForge } from "app/domain/font-convertor/font-forge/font-forge";

export abstract class FontForgeConvertor extends Convertor {
    public constructor(protected readonly fontForge: FontForge) {
        super();
    }
}
