import "reflect-metadata";
import { expect } from "chai";
import { sleep, withTimeout } from "app/shared/utils";

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

    it("passes a rejection through while it is still waiting", async () => {
        try {
            await withTimeout(Promise.reject(new Error("failed")), 100);
            expect.fail("expected the rejection to propagate");
        } catch (error) {
            expect((error as Error).message).to.equal("failed");
        }
    });
});
