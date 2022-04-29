import * as config from "../../../config";
import { SlotManager } from "./SlotManager";

export class UserSlotManager extends SlotManager {
    public static build(): UserSlotManager {
        return new UserSlotManager(config.managerLimits.user);
    }
}
