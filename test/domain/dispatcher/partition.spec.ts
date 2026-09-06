import { expect } from "chai";
import { Partition } from "app/domain/dispatcher/partition";
import { PRIORITY, Task } from "app/domain/dispatcher/task";

const rateNumber = 10;
const rateInterval = 1000;
const reserveDuration = rateInterval / rateNumber;

describe("Partition", function () {
    this.timeout(rateInterval * 3);

    it("takes a task of the higher priority first", function () {
        const partition = build();
        partition.push(task("low"), PRIORITY.LOW);
        partition.push(task("high"), PRIORITY.HIGH);

        expect(partition.take(PRIORITY.HIGH)?.key).to.equal("high");
    });

    it("takes tasks of one priority in the order they were pushed", async function () {
        const partition = build();
        partition.push(task("first"), PRIORITY.MEDIUM);
        partition.push(task("second"), PRIORITY.MEDIUM);

        expect(partition.take(PRIORITY.MEDIUM)?.key).to.equal("first");
        await delay(reserveDuration + 10);
        expect(partition.take(PRIORITY.MEDIUM)?.key).to.equal("second");
    });

    it("reserves its rate limit on take", function () {
        const partition = build();
        partition.push(task("only"), PRIORITY.MEDIUM);

        partition.take(PRIORITY.MEDIUM);

        expect(partition.isFree()).to.be.false;
    });

    it("returns null while the rate limit is not free", function () {
        const partition = build();
        partition.push(task("first"), PRIORITY.MEDIUM);
        partition.push(task("second"), PRIORITY.MEDIUM);

        partition.take(PRIORITY.MEDIUM);

        expect(partition.take(PRIORITY.MEDIUM)).to.be.null;
        expect(partition.size).to.equal(1);
    });

    it("is empty but not idle while the rate limit is cooling down", function () {
        const partition = build();
        partition.push(task("only"), PRIORITY.MEDIUM);

        partition.take(PRIORITY.MEDIUM);

        expect(partition.isEmpty()).to.be.true;
        expect(partition.isIdle()).to.be.false;
    });

    it("is idle when it is empty and the rate limit has cooled down", async function () {
        const partition = build();
        partition.push(task("only"), PRIORITY.MEDIUM);

        partition.take(PRIORITY.MEDIUM);
        await delay(reserveDuration + 10);

        expect(partition.isIdle()).to.be.true;
    });

    it("is not idle while it still holds tasks", async function () {
        const partition = build();
        partition.push(task("first"), PRIORITY.MEDIUM);
        partition.push(task("second"), PRIORITY.MEDIUM);

        partition.take(PRIORITY.MEDIUM);
        await delay(reserveDuration + 10);

        expect(partition.isIdle()).to.be.false;
    });
});

function build(): Partition {
    return new Partition({
        interval: rateInterval,
        number: rateNumber,
    });
}

function task(key: string): Task {
    return {
        key: key,
        rate: {
            interval: rateInterval,
            number: rateNumber,
        },
        priorityOnError: PRIORITY.HIGH,
        callback: () => Promise.resolve(),
    };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
