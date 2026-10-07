export const MS_PER_SECOND = 1000;
export const MS_PER_DAY = 24 * 60 * 60 * MS_PER_SECOND;
// The longest delay of a Node timer, a signed 32-bit integer: Node turns a longer one into 1 ms.
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
