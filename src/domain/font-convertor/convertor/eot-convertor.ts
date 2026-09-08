import { Convertor } from "app/domain/font-convertor/convertor/convertor";
import { EotPacker } from "app/domain/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { FontForge } from "app/domain/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/domain/font-convertor/font-signature-matcher";

export abstract class EotConvertor extends Convertor {
    public constructor(
        protected readonly fontForge: FontForge,
        fontSignatureMatcher: FontSignatureMatcher,
        protected readonly eotPacker: EotPacker,
    ) {
        super(fontSignatureMatcher);
    }

    /**
     * Путь промежуточного sfnt. Имя результата уникально в пределах каталога, значит
     * уникально и производное от него.
     */
    protected intermediatePath(newPath: string): string {
        return `${newPath}.${Extension.TTF}`;
    }
}
