import { Convertor } from "app/domain/font-convertor/convertor/convertor";
import { EotPacker } from "app/domain/font-convertor/eot-packer/eot-packer";
import { FontForge } from "app/domain/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/domain/font-convertor/font-signature-matcher";

/**
 * Пара, которой хватает одного кодека: исходник и результат отличаются только конвертом.
 * Движок в конструктор приходит всё равно — порядок параметров задан `ConvertorFactory`.
 */
export abstract class EotConvertor extends Convertor {
    public constructor(_fontForge: FontForge, fontSignatureMatcher: FontSignatureMatcher, protected readonly eotPacker: EotPacker) {
        super(fontSignatureMatcher);
    }
}
