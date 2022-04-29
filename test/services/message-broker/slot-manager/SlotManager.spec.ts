import { GroupSlotManager } from "../../../../src/modules/broker/slot-manager/GroupSlotManager";
import { expect } from "chai";

const limitNumber = 10;
const limitInterval = 1000;
const slotTimeout = limitInterval / limitNumber;

describe("SlotManager", function () {
    this.timeout(limitInterval * 3);
    it("slot-manager is empty", function () {
        const manager = build();

        expect(manager.isEmpty()).to.be.true;
    });

    it("manager is not empty after reserve", function () {
        const manager = build();

        manager.reserve();

        expect(manager.isEmpty()).to.be.false;
    });

    it("manager is free", function () {
        const manager = build();

        expect(manager.isFree()).to.be.true;
    });

    it("manager is not free after reserve", function () {
        const manager = build();

        manager.reserve();

        expect(manager.isFree()).to.be.false;
    });

    it("manager is free after timeout reserve", function () {
        const manager = build();

        manager.reserve();

        setTimeout(() => {
            expect(manager.isFree()).to.be.true;
        }, slotTimeout);
    });

    it("catch an error when calling a reserve while they are not free", function () {
        const manager = build();

        manager.reserve();
        expect(manager.reserve.call(manager)).to.throw(Error, "Can't reserve a slot until they're free");
    });
});

function build(): GroupSlotManager {
    return new GroupSlotManager({
        interval: limitInterval,
        number: limitNumber,
    });
}
