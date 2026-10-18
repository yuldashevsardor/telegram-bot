export type SessionPayload = {
    requestCount: number;
    // The album the last request to send a file went to: an album gets it once (NotAFileMiddleware).
    hintedMediaGroupId?: string;
};

export type SessionRow = {
    key: string;
    value: SessionPayload;
    created_time: Date;
    updated_time: Date;
};
