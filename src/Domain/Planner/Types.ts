import { Limit } from "App/Domain/SlotManager/SlotManager";

export type Limits = {
    common: Limit;
    private: Limit;
    group: Limit;
};
