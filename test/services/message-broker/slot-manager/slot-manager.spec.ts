import { expect } from "chai";
import { SlotManager } from "src/domain/slot-manager/slot-manager";

const limitNumber = 10;
const limitInterval = 1000;
const slotTimeout = limitInterval / limitNumber;

describe("SlotManager", function () {
    this.timeout(limitInterval * 3);

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

function build(): SlotManager {
    return new SlotManager({
        interval: limitInterval,
        number: limitNumber,
    });
}
