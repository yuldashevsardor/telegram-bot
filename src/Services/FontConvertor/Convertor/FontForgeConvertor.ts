import { Convertor } from "App/Services/FontConvertor/Convertor/Convertor";
import { FontForge } from "App/Services/FontConvertor/FontForge/FontForge";

export abstract class FontForgeConvertor extends Convertor {
    public constructor(protected readonly fontForge: FontForge) {
        super();
    }
}
