import { Extension } from "app/font-convertor/font-convertor.types";
import { FromEotConvertor } from "app/font-convertor/convertor/from-eot-convertor";

export class EotToSvg extends FromEotConvertor {
    protected toExtension: Extension = Extension.SVG;
}
