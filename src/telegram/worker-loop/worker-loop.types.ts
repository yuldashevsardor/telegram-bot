// Who takes the items of a loop, written into every attempt the loop makes: the node, and the loop
// among the restarts of the process. workerId names the loop, not one of its slots. OutboxWorker and
// InboxWorker are this type under the names of their stores.
export type WorkerIdentity = {
    host: string;
    pid: number;
    workerId: string;
};
