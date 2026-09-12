import { Extension } from "app/font-convertor/font-convertor.types";
import { ToEotConvertor } from "app/font-convertor/convertor/to-eot-convertor";

export class OtfToEot extends ToEotConvertor {
    protected fromExtension: Extension = Extension.OTF;
}
