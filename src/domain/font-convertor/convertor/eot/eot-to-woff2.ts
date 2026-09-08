import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { FromEotConvertor } from "app/domain/font-convertor/convertor/from-eot-convertor";

export class EotToWoff2 extends FromEotConvertor {
    protected toExtension: Extension = Extension.WOFF2;
}
