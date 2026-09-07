// Ждёт завершения не дольше срока: true — успело, false — срок вышел, а шаг остался
// выполняться. Опоздавший отказ безопасен: Promise.race уже подписан на step, поэтому
// такой отказ считается обработанным и не станет unhandledRejection.
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
