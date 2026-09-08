import { Convertor } from "app/domain/font-convertor/convertor/convertor";
import { EotPacker } from "app/domain/font-convertor/eot-packer/eot-packer";
import { FontForge } from "app/domain/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/domain/font-convertor/font-signature-matcher";

/**
 * Общий конструктор пар с EOT. Порядок параметров задан `ConvertorFactory`, поэтому движок
 * приходит сюда и к парам, которым он не нужен.
 */
export abstract class EotConvertor extends Convertor {
    public constructor(
        protected readonly fontForge: FontForge,
        fontSignatureMatcher: FontSignatureMatcher,
        protected readonly eotPacker: EotPacker,
    ) {
        super(fontSignatureMatcher);
    }
}
