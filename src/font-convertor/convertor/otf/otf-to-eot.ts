import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { ToEotConvertor } from "app/domain/font-convertor/convertor/to-eot-convertor";

export class OtfToEot extends ToEotConvertor {
    protected fromExtension: Extension = Extension.OTF;
}
