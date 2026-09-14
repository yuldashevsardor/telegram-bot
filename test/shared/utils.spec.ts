import "reflect-metadata";
import { expect } from "chai";
import { sleep, withTimeout } from "app/shared/utils";

function activeTimers(): number {
    return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

describe("withTimeout", () => {
    it("reports success when the step finishes in time", async () => {
        expect(await withTimeout(sleep(1), 100)).to.equal(true);
    });

    it("reports failure when the step does not finish in time", async () => {
        expect(await withTimeout(sleep(100), 1)).to.equal(false);
    });

    it("stops waiting on a zero timeout", async () => {
        expect(await withTimeout(sleep(100), 0)).to.equal(false);
    });

    it("swallows a rejection of the step it stopped waiting for", async () => {
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown): void => {
            rejections.push(reason);
        };

        process.on("unhandledRejection", onRejection);

        try {
            const failing = sleep(10).then(() => {
                throw new Error("too late");
            });

            expect(await withTimeout(failing, 1)).to.equal(false);

            await sleep(50);
            expect(rejections).to.deep.equal([]);
        } finally {
            process.off("unhandledRejection", onRejection);
        }
    });

    // Неснятый таймер держит цикл событий до срока. Шаг — уже выполненный промис, поэтому между
    // замерами идут одни микрозадачи и чужой таймер сработать не успевает. Свой таймер на тест
    // mocha заводит, когда тест вернул промис (callFn в mocha/lib/runnable.js), — отсюда первый await.
    it("clears its timer once the step has finished", async () => {
        await Promise.resolve();
        const before = activeTimers();

        expect(await withTimeout(Promise.resolve(), 60_000)).to.equal(true);
        expect(activeTimers()).to.equal(before);
    });

    it("passes a rejection through while it is still waiting", async () => {
        try {
            await withTimeout(Promise.reject(new Error("failed")), 100);
            expect.fail("expected the rejection to propagate");
        } catch (error) {
            expect((error as Error).message).to.equal("failed");
        }
    });
});
