import { Convertor } from "App/Domain/FontConvertor/Convertor/Convertor";
import { FontForge } from "App/Domain/FontConvertor/FontForge/FontForge";

export abstract class FontForgeConvertor extends Convertor {
    public constructor(protected readonly fontForge: FontForge) {
        super();
    }
}
