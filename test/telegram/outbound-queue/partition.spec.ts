import { expect } from "chai";
import { Partition } from "app/telegram/outbound-queue/partition";
import { Priority, Task } from "app/telegram/outbound-queue/task";

const limitNumber = 10;
const limitInterval = 1000;
const reserveDuration = limitInterval / limitNumber;

describe("Partition", function () {
    this.timeout(limitInterval * 3);

    it("takes tasks only from the asked priority", function () {
        const partition = build();
        partition.push(task("low"), Priority.LOW);
        partition.push(task("high"), Priority.HIGH);

        expect(partition.take(Priority.MEDIUM)).to.be.null;
        expect(partition.take(Priority.HIGH)?.key).to.equal("high");
    });

    it("takes tasks of one priority in the order they were pushed", async function () {
        const partition = build();
        partition.push(task("first"), Priority.MEDIUM);
        partition.push(task("second"), Priority.MEDIUM);

        expect(partition.take(Priority.MEDIUM)?.key).to.equal("first");
        await delay(reserveDuration + 10);
        expect(partition.take(Priority.MEDIUM)?.key).to.equal("second");
    });

    it("reserves its rate limit on take", function () {
        const partition = build();
        partition.push(task("only"), Priority.MEDIUM);

        partition.take(Priority.MEDIUM);

        expect(partition.isFree()).to.be.false;
    });

    it("returns null while the rate limit is not free", function () {
        const partition = build();
        partition.push(task("first"), Priority.MEDIUM);
        partition.push(task("second"), Priority.MEDIUM);

        partition.take(Priority.MEDIUM);

        expect(partition.take(Priority.MEDIUM)).to.be.null;
        expect(partition.size).to.equal(1);
    });

    it("is empty but not idle while the rate limit is cooling down", function () {
        const partition = build();
        partition.push(task("only"), Priority.MEDIUM);

        partition.take(Priority.MEDIUM);

        expect(partition.isEmpty()).to.be.true;
        expect(partition.isIdle()).to.be.false;
    });

    it("is idle when it is empty and the rate limit has cooled down", async function () {
        const partition = build();
        partition.push(task("only"), Priority.MEDIUM);

        partition.take(Priority.MEDIUM);
        await delay(reserveDuration + 10);

        expect(partition.isIdle()).to.be.true;
    });

    it("is not idle while it still holds tasks", async function () {
        const partition = build();
        partition.push(task("first"), Priority.MEDIUM);
        partition.push(task("second"), Priority.MEDIUM);

        partition.take(Priority.MEDIUM);
        await delay(reserveDuration + 10);

        expect(partition.isIdle()).to.be.false;
    });
});

function build(): Partition {
    return new Partition({
        interval: limitInterval,
        number: limitNumber,
    });
}

function task(key: string): Task {
    return {
        key: key,
        priorityOnError: Priority.HIGH,
        callback: () => Promise.resolve(),
    };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
