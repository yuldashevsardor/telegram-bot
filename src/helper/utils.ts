// Ждёт завершения не дольше срока: true — успело, false — срок вышел, а шаг остался
// выполняться. Отказ опоздавшего шага гасится намеренно, иначе он всплыл бы как
// unhandledRejection уже после того, как ожидание признано законченным.
export async function withTimeout(step: Promise<unknown>, timeout: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;

    const expired = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(timeout, 0));
    });
    const finished = step.then(() => true);

    try {
        const inTime = await Promise.race([finished, expired]);

        if (!inTime) {
            finished.catch(() => undefined);
        }

        return inTime;
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
