export type DatabaseSettings = {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    connection: {
        max: number;
        idleTimeout: number;
        maxLifetime: number;
    };
};
