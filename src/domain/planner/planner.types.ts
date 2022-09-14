import { Limit } from "app/domain/slot-manager/slot-manager";

export type Limits = {
    common: Limit;
    private: Limit;
    group: Limit;
};
