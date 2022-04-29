export class BrokerAlreadyCreatedError extends Error {
    constructor(message = "Broker already created.") {
        super(message);
    }
}
