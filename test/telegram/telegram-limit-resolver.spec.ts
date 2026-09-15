import { expect } from "chai";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import type { PartitionKey, Task } from "app/telegram/outbound-queue/task";
import { Priority } from "app/telegram/outbound-queue/task";
import { TelegramLimitResolver } from "app/telegram/telegram-limit-resolver";

const limits: TelegramLimits = {
    common: { number: 30, interval: 1000 },
    private: { number: 3, interval: 1000 },
    group: { number: 20, interval: 60 * 1000 },
};

describe("TelegramLimitResolver", () => {
    const resolver = new TelegramLimitResolver(limits);

    it("gives a group chat the group limit", () => {
        expect(resolver.resolve(task(-100123))).to.equal(limits.group);
    });

    it("gives a private chat the private limit", () => {
        expect(resolver.resolve(task(123))).to.equal(limits.private);
    });

    it("gives a key that is not a chat ID the private limit instead of failing", () => {
        expect(resolver.resolve(task("abc"))).to.equal(limits.private);
    });
});

function task(key: PartitionKey): Task {
    return {
        key: key,
        priorityOnError: Priority.MEDIUM,
        callback: () => Promise.resolve(),
    };
}
