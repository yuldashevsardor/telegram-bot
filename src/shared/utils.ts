// Waits for the completion no longer than the deadline: true — it made it, false — the deadline is
// over and the step is still running. A late failure is safe: Promise.race is already subscribed to
// step, so such a failure counts as handled and will not become an unhandledRejection.
export async function withTimeout(step: Promise<unknown>, timeout: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;

    const expired = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(timeout, 0));
    });
    const finished = step.then(() => true);

    try {
        return await Promise.race([finished, expired]);
    } finally {
        clearTimeout(timer);
    }
}

export function sleep(time: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve();
        }, time);
    });
}
