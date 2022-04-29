import { SlotManager } from "./SlotManager";
import * as config from "../../../config";

export class CommonSlotManager extends SlotManager {
    private banExpirationTime: number | null;

    public ban(expirationTime: number): void {
        if (expirationTime < Date.now()) {
            return;
        }

        this.banExpirationTime = expirationTime;
    }

    public isFree(): boolean {
        if (this.isBanned()) {
            return false;
        }

        return super.isFree();
    }

    private isBanned(): boolean {
        return this.banExpirationTime !== null && this.banExpirationTime >= Date.now();
    }

    public static build(): CommonSlotManager {
        return new CommonSlotManager(config.managerLimits.common);
    }
}
