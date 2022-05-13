import { SlotManager } from "./SlotManager";
import * as config from "../../config";

export class CommonSlotManager extends SlotManager {
    public static build(): CommonSlotManager {
        return new CommonSlotManager(config.managerLimits.common);
    }
}
