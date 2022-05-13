import * as config from "../../config";
import { SlotManager } from "./SlotManager";

export class PrivateSlotManager extends SlotManager {
    public static build(): PrivateSlotManager {
        return new PrivateSlotManager(config.managerLimits.private);
    }
}
