import * as config from "../../config";
import { SlotManager } from "./SlotManager";

export class GroupSlotManager extends SlotManager {
    public static build(): GroupSlotManager {
        return new GroupSlotManager(config.managerLimits.group);
    }
}
