export type ProcessResult = {
    stdout: string;
    // Only the end of stderr: its last STDERR_TAIL_BYTES (process-helper.ts).
    stderr: string;
};

export type ProcessExit = ProcessResult & {
    // null when a signal ended the process.
    exitCode: number | null;
    signal: NodeJS.Signals | null;
};
