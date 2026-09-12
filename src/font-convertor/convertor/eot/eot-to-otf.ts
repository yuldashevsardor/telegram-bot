import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { FromEotConvertor } from "app/domain/font-convertor/convertor/from-eot-convertor";

export class EotToOtf extends FromEotConvertor {
    protected toExtension: Extension = Extension.OTF;
}
