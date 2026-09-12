export type SessionPayload = {
    requestCount: number;
};

export type SessionRow = {
    key: string;
    value: SessionPayload;
    created_time: Date;
    updated_time: Date;
};
